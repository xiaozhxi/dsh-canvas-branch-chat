/**
 * Document import/export for Branching Canvas.
 *
 * Import: DOCX -> Markdown (mammoth + turndown), PPTX -> Markdown with
 * per-slide headings and speaker notes (JSZip + a small OOXML reader).
 * Export: Markdown-ish sections -> a clean Word document or a 16:9 deck.
 *
 * The goal is deliberately "basic but useful": readable source text and a
 * well-typeset new file. Editing an existing document in place while keeping
 * its original theme/master/styles is a different, much larger problem.
 */
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import JSZip from 'jszip'
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import pptxgen from 'pptxgenjs'

export const DOCUMENT_EXTENSIONS = new Set(['docx', 'pptx'])
export const MAX_PARSE_CHARS = 240000

const WORD_FONT = 'Microsoft YaHei'
const MONO_FONT = 'Consolas'
const INK = '172033'
const MUTED = '6B7280'
const ACCENT = 'B45309'
const LINE = 'E5E7EB'
const CREAM = 'F8F6F1'

function documentError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function isDocumentExtension(value) {
  return DOCUMENT_EXTENSIONS.has(String(value || '').toLowerCase())
}

export function documentLabel(value) {
  return String(value || '').toLowerCase() === 'pptx' ? 'PPT' : 'Word'
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function capText(value, limit = MAX_PARSE_CHARS) {
  const text = String(value || '')
  return {
    text: text.length > limit ? text.slice(0, limit) : text,
    truncated: text.length > limit,
    originalChars: text.length,
  }
}

function countWords(value) {
  const text = String(value || '')
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const latin = (text.match(/[A-Za-z0-9][A-Za-z0-9'’_-]*/g) || []).length
  return cjk + latin
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function htmlCellText(value) {
  return decodeXml(
    String(value || '')
      .replace(/<br\s*\/?>/gi, ' / ')
      .replace(/<\/p>/gi, ' / ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s*\/\s*(?=\/|$)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function htmlTableToMarkdown(table) {
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(table))) {
    const cells = []
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(htmlCellText(cellMatch[1]))
    }
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return ''
  const columns = Math.min(10, Math.max(1, ...rows.map((row) => row.length)))
  const pad = (row) => Array.from({ length: columns }, (_, index) => row[index] || '')
  const header = pad(rows[0])
  const separator = Array.from({ length: columns }, () => '---')
  const body = rows.slice(1).map((row) => `| ${pad(row).join(' | ')} |`)
  return [`| ${header.join(' | ')} |`, `| ${separator.join(' | ')} |`, ...body].join('\n')
}

function protectHtmlTables(html) {
  const tables = []
  const value = String(html || '').replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const markdown = htmlTableToMarkdown(table)
    if (!markdown) return ''
    const index = tables.push(markdown) - 1
    return `\n\nCCTABLEPLACEHOLDER${index}\n\n`
  })
  return { html: value, tables }
}

function warningList(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((item) => String(item && (item.message || item) ? item.message || item : '').trim())
    .filter(Boolean)
    .slice(0, 6)
}

/* -------------------------------------------------------------------------- */
/* Import                                                                      */
/* -------------------------------------------------------------------------- */

function makeTurndown() {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  })
  service.use(gfm)
  service.addRule('canvasImages', {
    filter: 'img',
    replacement: () => '',
  })
  return service
}

async function parseDocx(buffer) {
  let result
  try {
    result = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '', alt: '' })),
        ignoreEmptyParagraphs: true,
      }
    )
  } catch (error) {
    throw documentError('invalid-docx', `这个 Word 文件无法解析：${String(error && error.message ? error.message : error)}`)
  }
  let text = ''
  if (result && result.value && result.value.trim()) {
    const turndown = makeTurndown()
    const protectedHtml = protectHtmlTables(result.value)
    text = turndown.turndown(protectedHtml.html)
    protectedHtml.tables.forEach((table, index) => {
      text = text.replace(`CCTABLEPLACEHOLDER${index}`, `\n\n${table}\n\n`)
    })
  }
  if (!text.trim()) {
    try {
      const raw = await mammoth.extractRawText({ buffer })
      text = raw && raw.value ? raw.value : ''
    } catch {
      text = ''
    }
  }
  text = cleanText(text)
    .replace(/!\[\]\([^)]*\)/g, '')
    .replace(/[ \t]{2,}\n/g, '\n')
    .trim()
  if (!text) {
    throw documentError('empty-docx', '这个 Word 文件里没有可提取的文字，可能是纯图片文档。')
  }
  const capped = capText(text)
  return {
    docType: 'docx',
    text: capped.text,
    truncated: capped.truncated,
    meta: {
      type: 'docx',
      words: countWords(capped.text),
      characters: capped.text.length,
      originalChars: capped.originalChars,
      warnings: warningList(result && result.messages),
    },
  }
}

function extractPptParagraphs(xml) {
  const out = []
  const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi
  let match
  while ((match = pRe.exec(xml))) {
    const body = match[1]
    const parts = []
    const tokenRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/gi
    let token
    while ((token = tokenRe.exec(body))) {
      if (token[0].startsWith('<a:br')) {
        parts.push('\n')
      } else if (token[1]) {
        const decoded = decodeXml(token[1])
        if (decoded) parts.push(decoded)
      }
    }
    const text = parts
      .join('')
      .replace(/\u000b/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim()
    if (!text) continue
    const bullet = /<a:bu(?:Char|AutoNum|Blip)\b/i.test(body)
    const lvlMatch = /<a:pPr\b[^>]*\blvl="(\d+)"/i.exec(body)
    const level = Math.min(4, Math.max(0, Number(lvlMatch ? lvlMatch[1] : 0) || 0))
    out.push({ text, bullet, level })
  }
  return out
}

function extractPptTitle(xml) {
  const shapeRe = /<p:sp\b[\s\S]*?<\/p:sp>/gi
  let match
  while ((match = shapeRe.exec(xml))) {
    const shape = match[0]
    if (!/<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/i.test(shape)) continue
    const paragraphs = extractPptParagraphs(shape)
    if (paragraphs.length) return paragraphs[0].text.replace(/\s+/g, ' ').slice(0, 160)
  }
  return ''
}

async function readPptNotes(zip, slideNumber) {
  try {
    const rels = await zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`).async('string')
    const match = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/i.exec(rels)
    if (!match) return ''
    const xml = await zip.file(`ppt/notesSlides/${match[1]}`).async('string')
    if (!xml) return ''
    const paragraphs = extractPptParagraphs(xml)
      .map((item) => item.text.replace(/\s+/g, ' ').trim())
      .filter((item) => item && !/^\d{1,3}$/.test(item))
    return paragraphs.join(' ')
  } catch {
    return ''
  }
}

async function parsePptx(buffer) {
  let zip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw documentError('invalid-pptx', '这个 PPT 文件不是有效的 .pptx（旧版 .ppt 需要先另存为 .pptx）。')
  }
  let uncompressed = 0
  Object.keys(zip.files).forEach((name) => {
    const entry = zip.files[name]
    const size = entry && entry._data && Number(entry._data.uncompressedSize)
    if (Number.isFinite(size)) uncompressed += size
  })
  if (uncompressed > 400 * 1024 * 1024) {
    throw documentError('pptx-too-complex', '这个 PPT 解压后体积过大，无法安全解析。')
  }
  const slideFiles = Object.keys(zip.files)
    .map((name) => ({ name, match: /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name) }))
    .filter((item) => item.match)
    .map((item) => ({ name: item.name, number: Number(item.match[1]) }))
    .sort((a, b) => a.number - b.number)
  if (!slideFiles.length) {
    throw documentError('invalid-pptx', '这个文件里没有找到幻灯片内容。')
  }
  const warnings = []
  const parts = []
  let imageOnly = 0
  for (let index = 0; index < slideFiles.length; index += 1) {
    const slide = slideFiles[index]
    let xml = ''
    try {
      xml = await zip.file(slide.name).async('string')
    } catch {
      xml = ''
    }
    if (!xml) continue
    const title = extractPptTitle(xml)
    const paragraphs = extractPptParagraphs(xml)
    const body = paragraphs.filter((item, itemIndex) => !(itemIndex === 0 && title && item.text === title))
    const notes = await readPptNotes(zip, slide.number)
    const heading = title ? `## 幻灯片 ${index + 1}：${title}` : `## 幻灯片 ${index + 1}`
    parts.push(heading)
    if (!body.length) {
      imageOnly += 1
      parts.push('（此页没有可提取的文字，可能是图片、图表或 SmartArt。）')
    } else {
      body.forEach((item) => {
        const prefix = item.bullet ? `${'  '.repeat(item.level)}- ` : ''
        parts.push(prefix + item.text.replace(/\n+/g, ' '))
      })
    }
    if (notes) parts.push(`> 演讲者备注：${notes}`)
    parts.push('')
  }
  if (imageOnly) warnings.push(`${imageOnly} 页没有可提取文字，可能是图片型内容。`)
  const text = cleanText(parts.join('\n'))
  if (!text.trim()) {
    throw documentError('empty-pptx', '这个 PPT 里没有可提取的文字，可能是纯图片幻灯片。')
  }
  const capped = capText(text)
  return {
    docType: 'pptx',
    text: capped.text,
    truncated: capped.truncated,
    meta: {
      type: 'pptx',
      slides: slideFiles.length,
      words: countWords(capped.text),
      characters: capped.text.length,
      originalChars: capped.originalChars,
      warnings: warnings.slice(0, 6),
    },
  }
}

export async function parseDocument(buffer, extension) {
  const ext = String(extension || '').toLowerCase()
  if (ext === 'docx') return parseDocx(buffer)
  if (ext === 'pptx') return parsePptx(buffer)
  throw documentError('unsupported-document', '目前支持 .docx 和 .pptx 文档。')
}

/* -------------------------------------------------------------------------- */
/* Markdown -> blocks                                                          */
/* -------------------------------------------------------------------------- */

function inlineRuns(text, base = {}) {
  const source = String(text || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
  const runs = []
  let index = 0
  let buffer = ''
  let bold = false
  let italics = false
  let code = false
  const flush = () => {
    if (!buffer) return
    runs.push(
      new TextRun({
        ...base,
        text: buffer,
        bold: bold || base.bold || false,
        italics: italics || base.italics || false,
        font: code ? MONO_FONT : base.font || WORD_FONT,
        shading: code ? { type: ShadingType.CLEAR, fill: 'F1F3F5' } : undefined,
      })
    )
    buffer = ''
  }
  while (index < source.length) {
    if (source.startsWith('**', index)) {
      flush()
      bold = !bold
      index += 2
      continue
    }
    if (source[index] === '`') {
      flush()
      code = !code
      index += 1
      continue
    }
    if (source[index] === '*' && !source.startsWith('**', index)) {
      flush()
      italics = !italics
      index += 1
      continue
    }
    buffer += source[index]
    index += 1
  }
  flush()
  if (!runs.length) runs.push(new TextRun({ ...base, text: '', font: base.font || WORD_FONT }))
  return runs
}

function parseMarkdownBlocks(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let code = null
  let table = null
  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }
  const flushTable = () => {
    if (!table || !table.rows.length) {
      table = null
      return
    }
    blocks.push({ type: 'table', rows: table.rows })
    table = null
  }
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.replace(/\t/g, '  ')
    if (code) {
      if (/^\s*```/.test(line)) {
        blocks.push({ type: 'code', text: code.lines.join('\n') })
        code = null
      } else {
        code.lines.push(raw)
      }
      continue
    }
    if (/^\s*```/.test(line)) {
      flushParagraph()
      flushTable()
      code = { lines: [] }
      continue
    }
    const fence = /^\s*```/
    if (fence.test(line)) continue
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushTable()
      blocks.push({ type: 'heading', level: Math.min(4, heading[1].length), text: heading[2].trim() })
      continue
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph()
      flushTable()
      blocks.push({ type: 'rule' })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph()
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) {
        if (table) table.separator = true
        continue
      }
      if (!table) table = { rows: [] }
      table.rows.push(cells)
      continue
    }
    flushTable()
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      const indent = Math.min(3, Math.floor((raw.match(/^\s*/) || [''])[0].length / 2))
      blocks.push({ type: 'bullet', level: indent, text: bullet[1].trim() })
      continue
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      blocks.push({ type: 'ordered', text: `${ordered[1]}. ${ordered[2].trim()}` })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      blocks.push({ type: 'quote', text: quote[1].trim() })
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    paragraph.push(line.trim())
  }
  if (code) blocks.push({ type: 'code', text: code.lines.join('\n') })
  flushParagraph()
  flushTable()
  return blocks
}

function docxParagraph(block) {
  if (block.type === 'heading') {
    return new Paragraph({
      heading: [HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_4][block.level - 1] || HeadingLevel.HEADING_4,
      spacing: { before: 220, after: 100 },
      children: inlineRuns(block.text, { color: INK }),
    })
  }
  if (block.type === 'bullet') {
    return new Paragraph({
      bullet: { level: Math.min(3, block.level) },
      spacing: { after: 70 },
      children: inlineRuns(block.text),
    })
  }
  if (block.type === 'ordered') {
    return new Paragraph({
      indent: { left: 360 },
      spacing: { after: 70 },
      children: inlineRuns(block.text),
    })
  }
  if (block.type === 'quote') {
    return new Paragraph({
      indent: { left: 360 },
      border: { left: { color: 'D97706', style: BorderStyle.SINGLE, size: 12, space: 10 } },
      spacing: { before: 80, after: 120 },
      children: inlineRuns(block.text, { color: MUTED, italics: true }),
    })
  }
  if (block.type === 'code') {
    return new Paragraph({
      shading: { type: ShadingType.CLEAR, fill: 'F6F7F9' },
      spacing: { before: 80, after: 120 },
      children: [
        new TextRun({
          text: block.text || ' ',
          font: MONO_FONT,
          size: 19,
          color: '334155',
        }),
      ],
    })
  }
  if (block.type === 'rule') {
    return new Paragraph({
      border: { bottom: { color: LINE, style: BorderStyle.SINGLE, size: 6, space: 6 } },
      spacing: { before: 80, after: 120 },
      children: [],
    })
  }
  return new Paragraph({
    spacing: { after: 120, line: 300 },
    children: inlineRuns(block.text),
  })
}

function docxTable(block) {
  const rows = block.rows.slice(0, 40)
  const columnCount = Math.min(8, Math.max(1, ...rows.map((row) => row.length)))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          children: Array.from({ length: columnCount }, (_, cellIndex) =>
            new TableCell({
              shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: 'F1F3F5' } : undefined,
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
              children: [
                new Paragraph({
                  spacing: { after: 0 },
                  children: inlineRuns(row[cellIndex] || '', { bold: rowIndex === 0, size: 20 }),
                }),
              ],
            })
          ),
        })
    ),
  })
}

function docxSection(section, index, total) {
  const children = []
  if (index > 0) {
    children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  const title = String(section.title || (index === 0 ? '对话记录' : `第 ${index + 1} 部分`)).trim()
  children.push(
    new Paragraph({
      spacing: { before: index === 0 ? 0 : 120, after: 140 },
      children: [
        new TextRun({ text: `0${index + 1}`.slice(-2), font: WORD_FONT, size: 20, color: ACCENT, bold: true }),
        new TextRun({ text: '  ', font: WORD_FONT, size: 20 }),
        new TextRun({ text: title, font: WORD_FONT, size: 32, bold: true, color: INK }),
      ],
    })
  )
  const blocks = parseMarkdownBlocks(section.answer || '')
  if (!blocks.length) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: '（这一部分还没有回答）', font: WORD_FONT, color: MUTED })],
      })
    )
  } else {
    blocks.forEach((block) => {
      if (block.type === 'table') children.push(docxTable(block))
      else children.push(docxParagraph(block))
    })
  }
  if (index < total - 1) children.push(new Paragraph({ spacing: { after: 160 }, children: [] }))
  return children
}

export async function buildDocx({ title, sections, subtitle }) {
  const list = Array.isArray(sections) ? sections.slice(0, 40) : []
  const docTitle = String(title || '画布对话').replace(/\s+/g, ' ').trim().slice(0, 120) || '画布对话'
  const generatedAt = new Date()
  const dateText = generatedAt.toLocaleString('zh-CN', { hour12: false })
  const cover = [
    new Paragraph({
      spacing: { before: 1800, after: 180 },
      children: [new TextRun({ text: 'DSH  ·  CANVAS CHAT', font: WORD_FONT, size: 18, color: ACCENT, bold: true, characterSpacing: 40 })],
    }),
    new Paragraph({
      spacing: { after: 220, line: 560 },
      children: [new TextRun({ text: docTitle, font: WORD_FONT, size: 58, bold: true, color: INK })],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: subtitle || '从画布对话整理出的文档', font: WORD_FONT, size: 24, color: MUTED })],
    }),
    new Paragraph({
      spacing: { before: 120, after: 160 },
      border: { bottom: { color: 'D97706', style: BorderStyle.SINGLE, size: 14, space: 14 } },
      children: [],
    }),
    new Paragraph({
      children: [new TextRun({ text: `生成于 ${dateText}  ·  ${list.length} 个部分`, font: WORD_FONT, size: 18, color: MUTED })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ]
  const body = []
  list.forEach((section, index) => body.push(...docxSection(section, index, list.length)))
  if (!list.length) {
    body.push(
      new Paragraph({
        children: [new TextRun({ text: '没有可导出的内容。', font: WORD_FONT, color: MUTED })],
      })
    )
  }
  const document = new Document({
    creator: 'DSH Branching Canvas',
    title: docTitle,
    description: subtitle || 'Branching Canvas export',
    styles: {
      default: {
        document: {
          run: { font: WORD_FONT, size: 22, color: '273142' },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, right: 1191, bottom: 1134, left: 1191 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: { bottom: { color: LINE, style: BorderStyle.SINGLE, size: 4, space: 6 } },
                children: [new TextRun({ text: docTitle, font: WORD_FONT, size: 16, color: MUTED })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: 'DSH Branching Canvas  ·  ', font: WORD_FONT, size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.CURRENT], font: WORD_FONT, size: 16, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children: cover.concat(body),
      },
    ],
  })
  return Packer.toBuffer(document)
}

/* -------------------------------------------------------------------------- */
/* PPTX export                                                                */
/* -------------------------------------------------------------------------- */

function stripSlideMarkdown(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>]/g, '')
    .replace(/^\s*[-+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitLongBullet(value, limit = 150) {
  const text = String(value || '').trim()
  if (!text) return []
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1)
    const cut = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('；'),
      window.lastIndexOf('. '),
      window.lastIndexOf('; ')
    )
    const at = cut > limit * 0.45 ? cut + 1 : limit
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

function answerBullets(answer) {
  const source = String(answer || '').replace(/\r\n?/g, '\n')
  const out = []
  const tableLines = []
  let inCode = false
  source.split('\n').forEach((raw) => {
    const line = raw.trim()
    if (/^```/.test(line)) {
      inCode = !inCode
      return
    }
    if (inCode) return
    if (!line) return
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes('-')) return
    if (line.startsWith('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => stripSlideMarkdown(cell)).filter(Boolean)
      if (cells.length) tableLines.push(cells.join(' · '))
      return
    }
    const text = stripSlideMarkdown(line)
    if (!text) return
    splitLongBullet(text).forEach((part) => {
      if (part) out.push(part)
    })
  })
  if (!out.length && tableLines.length) out.push(...tableLines)
  if (tableLines.length && out.length) out.push(...tableLines)
  return out.filter((item, index, list) => list.indexOf(item) === index).slice(0, 36)
}

function chunk(list, size) {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

export async function buildPptx({ title, sections, subtitle }) {
  const list = Array.isArray(sections) ? sections.filter(Boolean).slice(0, 28) : []
  const deckTitle = String(title || '画布对话').replace(/\s+/g, ' ').trim().slice(0, 80) || '画布对话'
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'DSH Branching Canvas'
  pptx.company = 'DSH'
  pptx.subject = subtitle || 'Branching Canvas export'
  pptx.title = deckTitle
  const dateText = new Date().toLocaleDateString('zh-CN')
  let page = 1

  const cover = pptx.addSlide()
  cover.background = { color: '172033' }
  cover.addShape(pptx.ShapeType.rect, { x: 0.8, y: 1.7, w: 0.7, h: 0.06, fill: { color: 'D97706' }, line: { color: 'D97706' } })
  cover.addText('DSH  ·  CANVAS CHAT', {
    x: 0.8,
    y: 1.95,
    w: 8,
    h: 0.3,
    fontFace: WORD_FONT,
    fontSize: 10,
    bold: true,
    color: 'D9A45B',
    charSpacing: 1.4,
  })
  cover.addText(deckTitle, {
    x: 0.8,
    y: 2.45,
    w: 11.6,
    h: 1.8,
    fontFace: WORD_FONT,
    fontSize: 34,
    bold: true,
    color: 'FFFFFF',
    breakLine: false,
    valign: 'top',
    fit: 'shrink',
  })
  cover.addText(subtitle || '从画布对话整理出的演示文稿', {
    x: 0.8,
    y: 4.4,
    w: 10.5,
    h: 0.5,
    fontFace: WORD_FONT,
    fontSize: 14,
    color: 'B9C0CC',
  })
  cover.addText(`${dateText}  ·  ${list.length} 个部分`, {
    x: 0.8,
    y: 6.55,
    w: 8,
    h: 0.3,
    fontFace: WORD_FONT,
    fontSize: 10,
    color: '7E8797',
  })

  function addFooter(slide, number) {
    slide.addText('DSH Branching Canvas', {
      x: 0.75,
      y: 6.92,
      w: 5,
      h: 0.22,
      fontFace: WORD_FONT,
      fontSize: 8,
      color: '9AA1AC',
    })
    slide.addText(String(number).padStart(2, '0'), {
      x: 12.2,
      y: 6.9,
      w: 0.45,
      h: 0.24,
      fontFace: WORD_FONT,
      fontSize: 9,
      color: '9AA1AC',
      align: 'right',
    })
  }

  function addContentSlide(slideTitle, bullets, sectionNumber) {
    page += 1
    const slide = pptx.addSlide()
    slide.background = { color: CREAM }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.09, fill: { color: 'D97706' }, line: { color: 'D97706' } })
    slide.addText('DSH  /  CANVAS CHAT', {
      x: 0.75,
      y: 0.35,
      w: 6,
      h: 0.24,
      fontFace: WORD_FONT,
      fontSize: 8.5,
      color: '9A6A34',
      charSpacing: 0.8,
    })
    slide.addText(String(sectionNumber).padStart(2, '0'), {
      x: 12.1,
      y: 0.32,
      w: 0.5,
      h: 0.3,
      fontFace: WORD_FONT,
      fontSize: 12,
      bold: true,
      color: 'C17416',
      align: 'right',
    })
    slide.addText(slideTitle, {
      x: 0.75,
      y: 0.78,
      w: 11.8,
      h: 1.05,
      fontFace: WORD_FONT,
      fontSize: bullets.length > 5 ? 23 : 26,
      bold: true,
      color: INK,
      valign: 'top',
      fit: 'shrink',
    })
    const body = bullets.length
      ? bullets.map((item) => ({ text: item, options: { bullet: true, breakLine: true, paraSpaceAfterPt: 9 } }))
      : [{ text: '（暂无内容）', options: { breakLine: true } }]
    slide.addText(body, {
      x: 0.9,
      y: 2.08,
      w: 11.55,
      h: 4.5,
      fontFace: WORD_FONT,
      fontSize: bullets.length > 5 ? 14 : bullets.length > 3 ? 16 : 18,
      color: '354052',
      valign: 'top',
      fit: 'shrink',
      breakLine: true,
    })
    addFooter(slide, page)
  }

  if (list.length > 1 && list.length <= 10) {
    page += 1
    const agenda = pptx.addSlide()
    agenda.background = { color: 'F8F6F1' }
    agenda.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.09, fill: { color: 'D97706' }, line: { color: 'D97706' } })
    agenda.addText('内容概览', {
      x: 0.75,
      y: 0.8,
      w: 10,
      h: 0.8,
      fontFace: WORD_FONT,
      fontSize: 30,
      bold: true,
      color: INK,
    })
    agenda.addText(
      list.map((section, index) => ({
        text: `${String(index + 1).padStart(2, '0')}    ${String(section.title || `第 ${index + 1} 部分`).replace(/\s+/g, ' ').slice(0, 52)}`,
        options: { breakLine: true, paraSpaceAfterPt: 13 },
      })),
      {
        x: 0.95,
        y: 2.0,
        w: 10.8,
        h: 4.2,
        fontFace: WORD_FONT,
        fontSize: 16,
        color: '354052',
        valign: 'top',
      }
    )
    addFooter(agenda, page)
  }

  let sectionNumber = 0
  let totalSlides = 0
  for (const section of list) {
    if (totalSlides >= 42) break
    const bullets = answerBullets(section.answer)
    const sectionTitle = String(section.title || `第 ${sectionNumber + 1} 部分`).replace(/\s+/g, ' ').trim() || `第 ${sectionNumber + 1} 部分`
    const chunks = bullets.length ? chunk(bullets, 6) : [[]]
    sectionNumber += 1
    chunks.forEach((items, index) => {
      if (totalSlides >= 42) return
      addContentSlide(index === 0 ? sectionTitle : `${sectionTitle}（续）`, items, sectionNumber)
      totalSlides += 1
    })
  }
  if (!list.length) {
    addContentSlide('没有可导出的内容', [], 1)
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }))
}

export async function buildDocument({ format, title, sections, subtitle }) {
  if (format === 'docx') {
    return { buffer: await buildDocx({ title, sections, subtitle }), extension: 'docx', format }
  }
  if (format === 'pptx') {
    return { buffer: await buildPptx({ title, sections, subtitle }), extension: 'pptx', format }
  }
  throw documentError('unsupported-format', '导出格式必须是 docx 或 pptx。')
}