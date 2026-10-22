/**
 * Host half of Branching Canvas.
 *
 * It owns two things only:
 *   1. A tiny JSON API over the Harness HTTP carrier for the canvas page.
 *   2. Model calls through DSH's own `llm` service, using the provider/model
 *      routes already configured in this profile. No API keys, base URLs or
 *      model settings are copied into this plugin.
 *
 * The canvas documents themselves are ordinary JSON files under
 * `$DSH_HOME/canvas-chat/boards/`, so they survive restarts and profile
 * reinstalls of the plugin code.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildDocument, documentLabel, isDocumentExtension, parseDocument } from './documents.js'

export const name = 'dsh-canvas-branch-chat'

/** The HTTP carrier is what this plugin needs to exist; `llm` is optional. */
export const inject = ['webServer', 'connection']

const BASE = '/canvas-chat'
const API = `${BASE}/api`
const MAX_BODY_BYTES = 24 * 1024 * 1024
const MAX_BOARD_BYTES = 1536 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_DOC_BYTES = 16 * 1024 * 1024
const MAX_TEXT_CHARS = 50000
const MAX_ATTACHMENTS = 4
const MODEL_CACHE_MS = 5 * 60 * 1000
const MODEL_LIST_TIMEOUT_MS = 4500
const EXPORT_ID_RE = /^e_[a-f0-9]{32}\.(?:docx|pptx)$/i

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'log',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
  'css', 'html', 'xml', 'sql', 'sh', 'ps1', 'ini', 'toml',
])
const DOC_EXTENSIONS = new Set(['docx', 'pptx'])
const FILE_ID_RE = /^a_[a-f0-9]{32}\.(?:png|jpg|jpeg|webp|gif|txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|log|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|css|html|xml|sql|sh|ps1|ini|toml|docx|pptx)$/i
const CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', tsv: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8', yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', jsx: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8',
  rb: 'text/plain; charset=utf-8', go: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8', c: 'text/plain; charset=utf-8', h: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8', html: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8', sql: 'text/plain; charset=utf-8', sh: 'text/plain; charset=utf-8',
  ps1: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const DEFAULT_SYSTEM = [
  '你正在 DSH 的「画布分叉聊天」中对话。这里的对话不是一条线，而是一棵可以不断分叉的树。',
  '请给出清晰、具体、可继续深入的回答；需要分点时使用 Markdown。',
  '不要提及这条系统说明，也不要说自己“在画布上”。',
].join('\n')

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function dataDir() {
  return path.join(homeDir(), 'canvas-chat')
}

function boardsDir() {
  return path.join(dataDir(), 'boards')
}

function filesDir() {
  return path.join(dataDir(), 'files')
}

function exportsDir() {
  return path.join(dataDir(), 'exports')
}

async function ensureDirs() {
  await fsp.mkdir(boardsDir(), { recursive: true })
  await fsp.mkdir(filesDir(), { recursive: true })
  await fsp.mkdir(exportsDir(), { recursive: true })
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

function safeId(value, prefix) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (ID_RE.test(raw)) return raw
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function nowIso() {
  return new Date().toISOString()
}

function cleanName(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (raw || fallback).replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 120)
}

function cleanRef(raw) {
  if (!raw || typeof raw !== 'object') return null
  const attachmentId = typeof raw.attachmentId === 'string' ? raw.attachmentId.trim() : ''
  const mediaType = typeof raw.mediaType === 'string' ? raw.mediaType.trim().toLowerCase() : ''
  const width = Math.round(Number(raw.width))
  const height = Math.round(Number(raw.height))
  const bytes = Math.round(Number(raw.bytes))
  if (!/^sha256:[a-f0-9]{64}$/i.test(attachmentId) || !IMAGE_TYPES.has(mediaType)) return null
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) return null
  if (!Number.isFinite(bytes) || bytes < 1) return null
  return { attachmentId, mediaType, width, height, bytes }
}

function cleanDocMeta(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  const slides = Math.max(0, Math.min(10000, Math.round(Number(raw.slides) || 0)))
  const words = Math.max(0, Math.round(Number(raw.words) || 0))
  const characters = Math.max(0, Math.round(Number(raw.characters) || 0))
  if (slides) out.slides = slides
  if (words) out.words = words
  if (characters) out.characters = characters
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.map((item) => cleanName(item, '')).filter(Boolean).slice(0, 6)
    : []
  if (warnings.length) out.warnings = warnings
  return Object.keys(out).length ? out : null
}

function cleanAttachments(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MAX_ATTACHMENTS)
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      if (!FILE_ID_RE.test(id)) return null
      const kind = item.kind === 'image' ? 'image' : item.kind === 'file' ? 'file' : ''
      if (!kind) return null
      const name = cleanName(item.name, kind === 'image' ? '图片' : '文件')
      const size = Math.max(0, Math.round(Number(item.size) || 0))
      if (kind === 'image') {
        const ref = cleanRef(item.ref)
        if (!ref) return null
        return {
          id,
          kind,
          name,
          mediaType: ref.mediaType,
          size: size || ref.bytes,
          width: ref.width,
          height: ref.height,
          ref,
        }
      }
      const text = typeof item.text === 'string' ? item.text.slice(0, MAX_TEXT_CHARS) : ''
      const docType = item.docType === 'pptx' ? 'pptx' : item.docType === 'docx' ? 'docx' : ''
      return {
        id,
        kind,
        name,
        mediaType: typeof item.mediaType === 'string' && item.mediaType ? item.mediaType.slice(0, 120) : 'text/plain',
        size,
        text,
        truncated: item.truncated === true || text.length >= MAX_TEXT_CHARS,
        ...(docType ? { docType, meta: cleanDocMeta(item.meta) } : {}),
      }
    })
    .filter(Boolean)
}

function extOf(name) {
  const match = /\.([a-z0-9]{1,12})$/i.exec(String(name || ''))
  return match ? match[1].toLowerCase() : ''
}

function fileTypeOf(id) {
  const ext = extOf(id)
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}

async function saveUploadedCopy(id, data) {
  await ensureDirs()
  const target = path.join(filesDir(), id)
  const resolved = path.resolve(target)
  if (!resolved.startsWith(`${path.resolve(filesDir())}${path.sep}`)) {
    const error = new Error('invalid-file-name')
    error.code = 'invalid-file-name'
    throw error
  }
  await fsp.writeFile(target, data)
}

async function handleUpload(ctx, req, res) {
  const body = await readJson(req)
  const kind = body.kind === 'image' ? 'image' : body.kind === 'file' ? 'file' : ''
  if (!kind) {
    sendJson(res, 400, { error: 'invalid-kind', message: '附件类型不正确。' })
    return
  }
  const name = cleanName(body.name, kind === 'image' ? '图片' : '文件')
  const encoded = typeof body.data === 'string' ? body.data : ''
  if (!encoded || encoded.length > MAX_BODY_BYTES) {
    sendJson(res, 413, { error: 'empty-or-too-large', message: '附件为空或过大。' })
    return
  }
  let bytes
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch {
    bytes = Buffer.alloc(0)
  }
  if (!bytes.length) {
    sendJson(res, 400, { error: 'invalid-base64', message: '附件编码无效。' })
    return
  }

  if (kind === 'image') {
    if (bytes.length > MAX_IMAGE_BYTES) {
      sendJson(res, 413, { error: 'image-too-large', message: '图片不能超过 8 MB。' })
      return
    }
    const mediaType = typeof body.mediaType === 'string' ? body.mediaType.trim().toLowerCase() : ''
    if (!IMAGE_TYPES.has(mediaType)) {
      sendJson(res, 415, { error: 'unsupported-image', message: '目前支持 PNG、JPEG、WebP、GIF 图片。' })
      return
    }
    const store = ctx.get('attachments')
    if (!store || typeof store.saveImages !== 'function') {
      sendJson(res, 503, { error: 'attachments-unavailable', message: '当前 DSH 没有启用附件服务，暂时不能发送图片。' })
      return
    }
    let ref
    try {
      const refs = await store.saveImages([{ data: new Uint8Array(bytes), mediaType, name }])
      ref = cleanRef(Array.isArray(refs) ? refs[0] : null)
    } catch (error) {
      sendJson(res, 400, {
        error: String(error?.code || 'image-rejected'),
        message: String(error?.message || '图片没有被 DSH 接受。'),
      })
      return
    }
    if (!ref) {
      sendJson(res, 500, { error: 'invalid-image-ref', message: '图片保存后没有拿到有效引用。' })
      return
    }
    const id = `a_${randomUUID().replace(/-/g, '')}.${IMAGE_EXT[mediaType]}`
    await saveUploadedCopy(id, bytes)
    sendJson(res, 200, {
      attachment: {
        id,
        kind: 'image',
        name,
        mediaType,
        size: bytes.length,
        width: ref.width,
        height: ref.height,
        ref,
      },
    })
    return
  }

  const ext = extOf(name)
  if (!DOC_EXTENSIONS.has(ext) && bytes.length > MAX_TEXT_BYTES) {
    sendJson(res, 413, { error: 'file-too-large', message: '文本文件不能超过 2 MB。' })
    return
  }
  if (DOC_EXTENSIONS.has(ext)) {
    if (bytes.length > MAX_DOC_BYTES) {
      sendJson(res, 413, { error: 'document-too-large', message: 'Word / PPT 文件不能超过 16 MB。' })
      return
    }
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      sendJson(res, 415, {
        error: 'invalid-document',
        message: ext === 'pptx' ? '这个 PPT 不是有效的 .pptx（旧版 .ppt 请先另存为 .pptx）。' : '这个 Word 不是有效的 .docx（旧版 .doc 请先另存为 .docx）。',
      })
      return
    }
    let parsed
    try {
      parsed = await parseDocument(bytes, ext)
    } catch (error) {
      sendJson(res, 422, {
        error: String(error?.code || 'document-parse-failed'),
        message: String(error?.message || '文档解析失败。'),
      })
      return
    }
    const text = String(parsed.text || '')
    if (!text.trim()) {
      sendJson(res, 422, { error: 'empty-document', message: '这个文件里没有可提取的文字。' })
      return
    }
    const id = `a_${randomUUID().replace(/-/g, '')}.${ext}`
    await saveUploadedCopy(id, bytes)
    sendJson(res, 200, {
      attachment: {
        id,
        kind: 'file',
        name,
        mediaType: CONTENT_TYPES[ext],
        size: bytes.length,
        docType: ext,
        text: text.slice(0, MAX_TEXT_CHARS),
        truncated: parsed.truncated === true || text.length > MAX_TEXT_CHARS,
        meta: parsed.meta || null,
      },
    })
    return
  }
  if (!TEXT_EXTENSIONS.has(ext)) {
    sendJson(res, 415, {
      error: 'unsupported-file',
      message: '目前支持文本文件，以及 Word（.docx）、PPT（.pptx）。PDF、Excel 和旧版 .doc/.ppt 暂不支持。',
    })
    return
  }
  if (bytes.includes(0)) {
    sendJson(res, 415, { error: 'binary-file', message: '这个文件看起来是二进制文件，请上传文本文件。' })
    return
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    sendJson(res, 415, { error: 'invalid-utf8', message: '文件不是有效的 UTF-8 文本。' })
    return
  }
  const id = `a_${randomUUID().replace(/-/g, '')}.${ext}`
  await saveUploadedCopy(id, bytes)
  sendJson(res, 200, {
    attachment: {
      id,
      kind: 'file',
      name,
      mediaType: 'text/plain',
      size: bytes.length,
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
    },
  })
}

async function serveFile(req, res, url) {
  const id = url.searchParams.get('id') || ''
  if (!FILE_ID_RE.test(id)) {
    sendJson(res, 404, { error: 'file-not-found' })
    return
  }
  const target = path.join(filesDir(), id)
  const resolved = path.resolve(target)
  if (!resolved.startsWith(`${path.resolve(filesDir())}${path.sep}`)) {
    sendJson(res, 400, { error: 'invalid-file-name' })
    return
  }
  let data
  try {
    data = await fsp.readFile(target)
  } catch {
    sendJson(res, 404, { error: 'file-not-found' })
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', fileTypeOf(id))
  res.setHeader('Content-Length', data.length)
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(data)
}

async function handleExport(req, res) {
  const body = await readJson(req)
  const boardId = typeof body.boardId === 'string' ? body.boardId.trim() : ''
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
  const format = body.format === 'pptx' ? 'pptx' : body.format === 'docx' ? 'docx' : ''
  if (!ID_RE.test(boardId) || !ID_RE.test(nodeId) || !format) {
    sendJson(res, 400, { error: 'invalid-export', message: '导出参数不完整。' })
    return
  }
  const board = await loadBoard(boardId)
  if (!board) {
    sendJson(res, 404, { error: 'board-not-found', message: '画布不存在。' })
    return
  }
  const scope = body.scope === 'branch' ? 'branch' : body.scope === 'node' ? 'node' : body.scope === 'aside' ? 'aside' : 'node'
  let sections
  try {
    sections = collectExportSections(board, nodeId, scope)
  } catch (error) {
    sendJson(res, 422, { error: String(error?.code || 'empty-export'), message: String(error?.message || '没有可导出的内容。') })
    return
  }
  const title = exportTitle(body.title, exportTitle(board.title, '画布导出'))
  let built
  try {
    built = await buildDocument({
      format,
      title,
      sections,
      subtitle: `来自画布「${exportTitle(board.title, '未命名画布')}」`,
    })
  } catch (error) {
    sendJson(res, 500, { error: 'export-failed', message: `生成文档失败：${String(error?.message || error)}` })
    return
  }
  await ensureDirs()
  const id = `e_${randomUUID().replace(/-/g, '')}.${built.extension}`
  const target = path.join(exportsDir(), id)
  await fsp.writeFile(target, built.buffer)
  void pruneExports(40)
  const name = exportFileName(title, built.extension)
  sendJson(res, 200, {
    file: {
      id,
      name,
      format,
      size: built.buffer.length,
      sections: sections.length,
      url: `${API}/export-file?id=${encodeURIComponent(id)}`,
    },
  })
}

async function serveExport(req, res, url) {
  const id = url.searchParams.get('id') || ''
  if (!EXPORT_ID_RE.test(id)) {
    sendJson(res, 404, { error: 'export-not-found' })
    return
  }
  const target = path.join(exportsDir(), id)
  const resolved = path.resolve(target)
  if (!resolved.startsWith(`${path.resolve(exportsDir())}${path.sep}`)) {
    sendJson(res, 400, { error: 'invalid-export-name' })
    return
  }
  let data
  try {
    data = await fsp.readFile(target)
  } catch {
    sendJson(res, 404, { error: 'export-not-found' })
    return
  }
  const extension = id.toLowerCase().endsWith('.pptx') ? 'pptx' : 'docx'
  res.statusCode = 200
  res.setHeader('Content-Type', CONTENT_TYPES[extension])
  res.setHeader('Content-Length', data.length)
  res.setHeader('Content-Disposition', `attachment; filename="canvas-chat-export.${extension}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(data)
}

async function writeJsonAtomic(file, value) {
  const text = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(text, 'utf8') > MAX_BOARD_BYTES) {
    const error = new Error('board-too-large')
    error.code = 'board-too-large'
    throw error
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, text, 'utf8')
  await fsp.rename(tmp, file)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request-too-large')
      error.code = 'request-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('invalid-json')
    error.code = 'invalid-json'
    throw error
  }
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function sendText(res, status, text) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

async function listBoards() {
  await ensureDirs()
  let entries = []
  try {
    entries = await fsp.readdir(boardsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const boards = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -5)
    if (!ID_RE.test(id)) continue
    try {
      const raw = await fsp.readFile(path.join(boardsDir(), entry.name), 'utf8')
      const board = JSON.parse(raw)
      const nodes = Array.isArray(board.nodes) ? board.nodes : []
      boards.push({
        id,
        title: typeof board.title === 'string' && board.title.trim() ? board.title.trim() : '未命名画布',
        createdAt: board.createdAt || nowIso(),
        updatedAt: board.updatedAt || board.createdAt || nowIso(),
        nodeCount: nodes.length,
        preview: nodes.find((n) => n && typeof n.prompt === 'string' && n.prompt.trim())?.prompt.trim().slice(0, 72) || '',
      })
    } catch {
      /* a half-written or foreign file is simply not a board */
    }
  }
  boards.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return boards
}

async function loadBoard(id) {
  if (!ID_RE.test(id)) return null
  await ensureDirs()
  try {
    const raw = await fsp.readFile(path.join(boardsDir(), `${id}.json`), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function cleanAsideMessages(input) {
  if (!Array.isArray(input)) return []
  let budget = 180000
  const out = []
  for (const message of input.slice(0, 40)) {
    if (!message || budget <= 0) break
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : ''
    const content = typeof message.content === 'string' ? message.content.slice(0, Math.min(60000, budget)) : ''
    if (!role || !content.trim()) continue
    out.push({ role, content })
    budget -= content.length
  }
  return out
}

async function saveBoard(input) {
  await ensureDirs()
  const board = input && typeof input === 'object' ? input : {}
  const id = safeId(board.id, 'b')
  const nodes = Array.isArray(board.nodes) ? board.nodes.slice(0, 600) : []
  const clean = {
    id,
    title:
      (typeof board.title === 'string' && board.title.trim().slice(0, 120)) ||
      nodes.find((n) => n && typeof n.prompt === 'string' && n.prompt.trim())?.prompt.trim().slice(0, 40) ||
      '未命名画布',
    createdAt: typeof board.createdAt === 'string' ? board.createdAt : nowIso(),
    updatedAt: nowIso(),
    viewport:
      board.viewport && typeof board.viewport === 'object'
        ? {
            x: Number(board.viewport.x) || 0,
            y: Number(board.viewport.y) || 0,
            scale: Math.min(2.4, Math.max(0.18, Number(board.viewport.scale) || 0.9)),
          }
        : { x: 0, y: 0, scale: 0.9 },
    nodes: nodes.map((node) => ({
      id: safeId(node && node.id, 'n'),
      parentId: node && typeof node.parentId === 'string' && ID_RE.test(node.parentId) ? node.parentId : null,
      prompt: typeof node?.prompt === 'string' ? node.prompt.slice(0, 20000) : '',
      attachments: cleanAttachments(node?.attachments),
      answer: typeof node?.answer === 'string' ? node.answer.slice(0, 120000) : '',
      reasoning: typeof node?.reasoning === 'string' ? node.reasoning.slice(0, 60000) : '',
      provider: typeof node?.provider === 'string' ? node.provider.slice(0, 120) : '',
      model: typeof node?.model === 'string' ? node.model.slice(0, 160) : '',
      x: Number(node?.x) || 0,
      y: Number(node?.y) || 0,
      createdAt: typeof node?.createdAt === 'string' ? node.createdAt : nowIso(),
      updatedAt: typeof node?.updatedAt === 'string' ? node.updatedAt : nowIso(),
      error: typeof node?.error === 'string' ? node.error.slice(0, 2000) : '',
      usage: node?.usage && typeof node.usage === 'object' ? node.usage : null,
      ...(node?.kind === 'aside'
        ? {
            kind: 'aside',
            anchorId: typeof node.anchorId === 'string' && ID_RE.test(node.anchorId) ? node.anchorId : null,
            quote: typeof node.quote === 'string' ? node.quote.slice(0, 4000) : '',
            messages: cleanAsideMessages(node.messages),
          }
        : {}),
    })),
  }
  await writeJsonAtomic(path.join(boardsDir(), `${id}.json`), clean)
  return clean
}

function exportTitle(value, fallback) {
  return (
    String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || fallback
  )
}

function exportFileName(title, extension) {
  const base =
    String(title || '画布导出')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 64) || '画布导出'
  const stamp = new Date()
    .toLocaleString('sv-SE', { hour12: false })
    .replace(/[-: ]/g, (char) => (char === ' ' ? '-' : ''))
    .slice(0, 13)
  return `${base}-${stamp}.${extension}`
}

function asideExportSection(node) {
  const messages = Array.isArray(node.messages) ? node.messages : []
  const quote = String(node.quote || '').trim()
  const firstQuestion =
    messages.find((message) => message && message.role === 'user' && String(message.content || '').trim())?.content ||
    node.prompt ||
    '临时对话'
  const parts = []
  if (quote) parts.push(`> 选中内容：${quote}`, '')
  if (!messages.length) {
    if (node.answer) parts.push(String(node.answer))
  } else {
    messages.forEach((message) => {
      const content = String(message && message.content ? message.content : '').trim()
      if (!content) return
      parts.push(message.role === 'assistant' ? content : `**你：** ${content}`, '')
    })
  }
  return {
    title: exportTitle(`临时对话：${String(firstQuestion).replace(/\s+/g, ' ')}`, '临时对话'),
    answer: parts.join('\n').trim(),
  }
}

function collectExportSections(board, nodeId, scope) {
  const nodes = Array.isArray(board.nodes) ? board.nodes : []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const selected = byId.get(nodeId)
  if (!selected) {
    const error = new Error('这个节点不存在。')
    error.code = 'node-not-found'
    throw error
  }
  let sections = []
  if (selected.kind === 'aside' || scope === 'aside') {
    sections = [asideExportSection(selected)]
  } else if (scope === 'branch') {
    const chain = []
    const seen = new Set()
    let cursor = selected
    while (cursor && !seen.has(cursor.id) && chain.length < 80) {
      seen.add(cursor.id)
      chain.push(cursor)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null
    }
    chain.reverse()
    sections = chain
      .filter((node) => node && node.kind !== 'aside')
      .map((node, index) => ({
        title: exportTitle(node.prompt, index === 0 ? '开始' : `第 ${index + 1} 步`),
        answer: String(node.answer || '').slice(0, 120000),
      }))
      .filter((section) => section.title || section.answer)
  } else {
    sections = [
      {
        title: exportTitle(selected.prompt, '对话回答'),
        answer: String(selected.answer || '').slice(0, 120000),
      },
    ]
  }
  let budget = 360000
  sections = sections.slice(-40).filter((section) => {
    if (budget <= 0) return false
    section.answer = String(section.answer || '').slice(0, Math.min(120000, budget))
    budget -= section.answer.length
    return !!(section.title || section.answer)
  })
  if (!sections.length) {
    const error = new Error('没有可导出的内容。')
    error.code = 'empty-export'
    throw error
  }
  return sections
}

async function pruneExports(keep = 40) {
  try {
    const entries = await fsp.readdir(exportsDir(), { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !EXPORT_ID_RE.test(entry.name)) continue
      const file = path.join(exportsDir(), entry.name)
      try {
        const stat = await fsp.stat(file)
        files.push({ file, mtime: stat.mtimeMs })
      } catch {
        /* ignore */
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)
    await Promise.all(files.slice(keep).map((item) => fsp.unlink(item.file).catch(() => {})))
  } catch {
    /* cleanup is best-effort */
  }
}

function withTimeout(promise, ms, fallback) {
  let timer
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Model directory built from the live `llm` service. Results are cached only
 * inside this plugin activation; a profile reload always re-reads config.
 */
function createModelCatalog(ctx) {
  let cache = null
  let cacheAt = 0

  async function build() {
    const llm = ctx.get('llm')
    const out = { hasLlm: false, providers: [], defaultSelection: null, fetchedAt: nowIso() }
    if (!llm) return out
    out.hasLlm = true

    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection) out.defaultSelection = selection
    } catch {
      /* optional surface */
    }

    let providers = []
    try {
      providers = llm.listProviders()
    } catch {
      providers = []
    }
    for (const provider of providers) {
      let models = []
      try {
        const list = await withTimeout(llm.listModels(provider.id), MODEL_LIST_TIMEOUT_MS, [])
        if (Array.isArray(list)) {
          models = list.map((model) => ({
            id: String(model.id),
            name: String(model.name || model.id),
            description: typeof model.description === 'string' ? model.description : '',
          }))
        }
      } catch {
        models = []
      }
      out.providers.push({ id: String(provider.id), name: String(provider.name || provider.id), models })
    }

    // The current default route is always selectable, even when the provider's
    // catalog endpoint is temporarily unreachable.
    const selection = out.defaultSelection
    if (selection && selection.provider && selection.model) {
      const provider = out.providers.find((p) => p.id === selection.provider)
      if (provider && !provider.models.some((m) => m.id === selection.model)) {
        provider.models.unshift({ id: String(selection.model), name: String(selection.model), description: '' })
      } else if (!provider) {
        out.providers.push({
          id: String(selection.provider),
          name: String(selection.provider),
          models: [{ id: String(selection.model), name: String(selection.model), description: '' }],
        })
      }
    }
    return out
  }

  return {
    async get(force) {
      if (!force && cache && Date.now() - cacheAt < MODEL_CACHE_MS) return cache
      cache = await build()
      cacheAt = Date.now()
      return cache
    },
    invalidate() {
      cache = null
      cacheAt = 0
    },
  }
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return []
  const clean = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-48)
    .map((m) => ({
      role: m.role,
      content: m.content,
      attachments: m.role === 'user' ? cleanAttachments(m.attachments) : [],
    }))
    .filter((m) => m.content.trim() || m.attachments.length)
  // Keep the deepest context bounded: image references are small, but text
  // attachments are copied into the prompt and can be expensive over a long
  // branch. Newest files win; older ones degrade to a plain name.
  let textBudget = 90000
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    const message = clean[i]
    for (const attachment of message.attachments) {
      if (attachment.kind !== 'file' || !attachment.text) continue
      if (textBudget <= 0) {
        attachment.text = ''
        attachment.truncated = true
        continue
      }
      if (attachment.text.length > textBudget) {
        attachment.text = attachment.text.slice(0, textBudget)
        attachment.truncated = true
      }
      textBudget -= attachment.text.length
    }
  }
  return clean
}

function userContent(message) {
  const content = [{ type: 'text', text: message.content }]
  for (const attachment of message.attachments || []) {
    if (attachment.kind === 'image' && attachment.ref) {
      content.push({ type: 'image', attachment: attachment.ref })
    } else if (attachment.kind === 'file' && attachment.text) {
      let label = `附件「${attachment.name}」`
      if (attachment.docType === 'pptx') {
        const slides = Number(attachment.meta && attachment.meta.slides) || 0
        label += slides ? `（PPT，共 ${slides} 页）` : '（PPT）'
      } else if (attachment.docType === 'docx') {
        const words = Number(attachment.meta && attachment.meta.words) || 0
        label += words ? `（Word 文档，约 ${words} 字）` : '（Word 文档）'
      }
      content.push({
        type: 'text',
        text: `${label}的内容${attachment.truncated ? '（已截断）' : ''}：\n${attachment.text}`,
      })
    }
  }
  return content
}

function toRequestMessages(history, provider, model) {
  return history.map((message, index) => {
    if (message.role === 'assistant') {
      return {
        id: `cc_${index}_${randomUUID().slice(0, 8)}`,
        role: 'assistant',
        content: [{ type: 'text', text: message.content }],
        source: { kind: 'model', provider, model },
        createdAt: new Date().toISOString(),
      }
    }
    return { role: 'user', content: userContent(message) }
  })
}

async function handleChat(ctx, req, res, body) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    sendJson(res, 503, { error: '尚未装配可用的模型服务。请先在 DSH 设置中配置模型提供方。' })
    return
  }

  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!provider || !model) {
    sendJson(res, 400, { error: '缺少模型路由（provider / model）。' })
    return
  }

  const history = normalizeHistory(body.messages)
  if (!history.length || history[history.length - 1].role !== 'user') {
    sendJson(res, 400, { error: '消息列表必须以一条用户消息结尾。' })
    return
  }

  const system =
    typeof body.system === 'string' && body.system.trim() ? body.system.slice(0, 20000) : DEFAULT_SYSTEM
  const messages = toRequestMessages(history, provider, model)

  const options = { provider, model, messages, system }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    options.temperature = Math.min(2, Math.max(0, body.temperature))
  }
  if (typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens)) {
    options.maxTokens = Math.max(16, Math.min(32000, Math.round(body.maxTokens)))
  }

  const abort = new AbortController()
  options.signal = abort.signal
  let closed = false
  const onClose = () => {
    if (!res.writableEnded) {
      closed = true
      abort.abort()
    }
  }
  res.on('close', onClose)

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const write = (payload) => {
    if (closed || res.writableEnded) return
    try {
      res.write(`${JSON.stringify(payload)}\n`)
    } catch {
      closed = true
    }
  }

  let finishReason = null
  try {
    write({ type: 'start', provider, model, at: nowIso() })
    const stream = llm.stream(options)
    for await (const chunk of stream) {
      if (closed) break
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && chunk.text) {
        write({ type: 'text', text: chunk.text })
      } else if (chunk.type === 'reasoning-delta' && chunk.text) {
        write({ type: 'reasoning', text: chunk.text })
      } else if (chunk.type === 'usage' && chunk.usage) {
        write({ type: 'usage', usage: chunk.usage })
      } else if (chunk.type === 'finish') {
        finishReason = chunk.reason || null
        if (chunk.reason?.kind === 'error') {
          write({
            type: 'error',
            message: chunk.reason.failure?.message || '模型调用失败。',
            code: chunk.reason.failure?.code || 'llm-error',
            status: chunk.reason.failure?.status,
          })
        } else if (chunk.reason?.kind === 'aborted') {
          write({ type: 'aborted' })
        } else if (chunk.reason?.kind === 'max-tokens') {
          write({ type: 'warning', message: '回答达到该模型的最大输出长度，已停止。' })
        }
      }
    }
    if (!closed) write({ type: 'done', reason: finishReason, at: nowIso() })
  } catch (error) {
    if (!closed) {
      write({
        type: 'error',
        message: String(error?.message || error),
        code: String(error?.code || 'llm-request-failed'),
        status: error?.status,
      })
    }
  } finally {
    res.removeListener('close', onClose)
    if (!res.writableEnded) res.end()
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') return () => {}

  const catalog = createModelCatalog(ctx)
  const disposers = []

  const route = (handler) => {
    disposers.push(
      ctx.effect(() =>
        webServer.register({
          kind: 'prefix',
          path: API,
          handler,
        }),
      ),
    )
  }

  route(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    const url = new URL(req.url || '/', 'http://canvas-chat.local')
    const endpoint = url.pathname.startsWith(`${API}/`) ? url.pathname.slice(API.length) : url.pathname

    try {
      const connection = ctx.get('connection')
      const admission = connection && typeof connection.admit === 'function'
        ? connection.admit({ headers: req.headers })
        : null
      if (admission && admission.rejection) {
        res.writeHead(admission.rejection, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      if (endpoint === '/health' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-canvas-branch-chat',
          hasLlm: !!ctx.get('llm'),
          hasAttachments: !!ctx.get('attachments'),
          dataDir: dataDir(),
        })
        return
      }

      if (endpoint === '/bootstrap' && method === 'GET') {
        const models = await catalog.get(false)
        const boards = await listBoards()
        sendJson(res, 200, {
          ...models,
          boards,
          system: DEFAULT_SYSTEM,
          storage: 'local-file',
          uploads: {
            image: !!ctx.get('attachments'),
            file: true,
            document: true,
            maxImageBytes: MAX_IMAGE_BYTES,
            maxFileBytes: MAX_TEXT_BYTES,
            maxDocumentBytes: MAX_DOC_BYTES,
            maxAttachments: MAX_ATTACHMENTS,
          },
        })
        return
      }

      if (endpoint === '/upload' && method === 'POST') {
        await handleUpload(ctx, req, res)
        return
      }

      if (endpoint === '/file' && method === 'GET') {
        await serveFile(req, res, url)
        return
      }

      if (endpoint === '/export' && method === 'POST') {
        await handleExport(req, res)
        return
      }

      if (endpoint === '/export-file' && method === 'GET') {
        await serveExport(req, res, url)
        return
      }

      if (endpoint === '/models' && method === 'GET') {
        sendJson(res, 200, await catalog.get(true))
        return
      }

      if (endpoint === '/board' && method === 'GET') {
        const id = url.searchParams.get('id') || ''
        const board = await loadBoard(id)
        if (!board) {
          sendJson(res, 404, { error: 'board-not-found' })
          return
        }
        sendJson(res, 200, { board })
        return
      }

      if (endpoint === '/board' && (method === 'POST' || method === 'PUT')) {
        const body = await readJson(req)
        const board = await saveBoard(body.board || body)
        sendJson(res, 200, { board })
        return
      }

      if (endpoint === '/board' && method === 'DELETE') {
        const id = url.searchParams.get('id') || ''
        if (!ID_RE.test(id)) {
          sendJson(res, 400, { error: 'invalid-id' })
          return
        }
        try {
          await fsp.unlink(path.join(boardsDir(), `${id}.json`))
        } catch {
          sendJson(res, 404, { error: 'board-not-found' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }

      if (endpoint === '/chat' && method === 'POST') {
        const body = await readJson(req)
        await handleChat(ctx, req, res, body)
        return
      }

      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      const code = String(error?.code || 'internal-error')
      const status = code === 'request-too-large' || code === 'board-too-large' ? 413 : code === 'invalid-json' ? 400 : 500
      if (!res.headersSent) {
        sendJson(res, status, { error: code, message: String(error?.message || error) })
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })

  void ensureDirs().catch(() => {})

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}

export default { name, inject, apply }