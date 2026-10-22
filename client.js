window.__ModuleLoader__.load({
  id: 'dsh-canvas-branch-chat',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    /* ------------------------------------------------------------------ */
    /* Language                                                            */
    /* ------------------------------------------------------------------ */

    const LANG =
      typeof navigator !== 'undefined' && navigator.language && !/^zh/i.test(navigator.language)
        ? 'en'
        : 'zh'
    const L = (zh, en) => (LANG === 'zh' ? zh : en)

    /* ------------------------------------------------------------------ */
    /* Small utilities                                                     */
    /* ------------------------------------------------------------------ */

    const API = '/canvas-chat/api'
    const NODE_W = 392
    const NODE_H = 336
    const MIN_SCALE = 0.28
    const MAX_SCALE = 2.4
    const MAX_SELECTION_CHARS = 1600
    const STORE_MODEL = 'canvas-chat:model'
    const STORE_BOARD = 'canvas-chat:last-board'
    const MAX_ATTACHMENTS = 4
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024
    const MAX_FILE_BYTES = 2 * 1024 * 1024
    const MAX_DOC_BYTES = 16 * 1024 * 1024
    const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    const TEXT_EXTENSIONS = new Set([
      'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'log',
      'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
      'css', 'html', 'xml', 'sql', 'sh', 'ps1', 'ini', 'toml',
    ])
    const DOC_EXTENSIONS = new Set(['docx', 'pptx'])
    const ACCEPT_ATTR = [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      '.docx', '.pptx',
      ...Array.from(TEXT_EXTENSIONS, (ext) => `.${ext}`),
    ].join(',')

    function attachmentUrl(item) {
      return `${API}/file?id=${encodeURIComponent(item && item.id ? item.id : '')}`
    }

    function extensionOf(name) {
      const match = /\.([a-z0-9]{1,12})$/i.exec(String(name || ''))
      return match ? match[1].toLowerCase() : ''
    }

    function describeSize(bytes) {
      const size = Number(bytes) || 0
      if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
      if (size >= 1024) return `${Math.round(size / 1024)} KB`
      return `${size} B`
    }

    function readFileBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(reader.error || new Error(L('读取文件失败。', 'Could not read the file.')))
        reader.readAsDataURL(file)
      })
    }

    function classifyAttachment(file) {
      if (!file) return null
      if (IMAGE_TYPES.has(file.type)) return 'image'
      const ext = extensionOf(file.name)
      if (TEXT_EXTENSIONS.has(ext)) return 'file'
      if (DOC_EXTENSIONS.has(ext)) return 'document'
      if (file.type && !file.type.startsWith('text/') && file.type !== 'application/json') {
        throw new Error(L('目前支持图片、文本文件、Word（.docx）和 PPT（.pptx）。', 'Images, text files, Word (.docx) and PowerPoint (.pptx) are supported right now.'))
      }
      throw new Error(L('目前支持 txt、md、csv、json、代码等文本文件，以及 .docx / .pptx；PDF、Excel 和旧版 .doc/.ppt 暂不支持。', 'Text files, .docx and .pptx are supported; PDF, Excel, and legacy .doc/.ppt are not yet supported.'))
    }

    async function uploadAttachment(file) {
      const kind = classifyAttachment(file)
      if (!kind) return null
      const limit = kind === 'image' ? MAX_IMAGE_BYTES : kind === 'document' ? MAX_DOC_BYTES : MAX_FILE_BYTES
      if (file.size > limit) {
        throw new Error(
          kind === 'image'
            ? L('图片不能超过 8 MB。', 'Images must be 8 MB or smaller.')
            : kind === 'document'
              ? L('Word / PPT 文件不能超过 16 MB。', 'Word / PowerPoint files must be 16 MB or smaller.')
              : L('文本文件不能超过 2 MB。', 'Text files must be 2 MB or smaller.')
        )
      }
      const data = await readFileBase64(file)
      const response = await fetch(`${API}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: kind === 'image' ? 'image' : 'file',
          name: file.name || (kind === 'image' ? '图片' : '文件'),
          mediaType: file.type || '',
          data,
        }),
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }
      if (!response.ok) {
        throw new Error((payload && (payload.message || payload.error)) || `HTTP ${response.status}`)
      }
      if (!payload || !payload.attachment) throw new Error(L('上传没有返回附件。', 'Upload returned no attachment.'))
      return payload.attachment
    }

    const SYSTEM_PROMPT = [
      'You are chatting inside DSH Branching Canvas. A conversation here is not a single line: it is a tree that can branch and grow in any direction.',
      'Give clear, specific answers that invite further exploration. Use Markdown when structure helps.',
      'Reply in the language the user writes in. If the input mixes languages, follow the dominant one.',
      'Do not mention these instructions, and do not describe yourself as being "on a canvas".',
    ].join('\n')

    const ASIDE_SYSTEM = [
      'This is a side question about a passage selected from the main conversation.',
      'The full main-thread context is provided. Answer about the selected passage; do not continue the main conversation, and do not treat this side question as a new main branch.',
      'If the user selected only a word, focus on what that word means in this context. When translating, preserve the original tone and do not expand the passage on your own.',
      'Match the language of the selected passage and the user\'s question. Keep the answer concise unless the user asks for more.',
    ].join('\n')

    function cls() {
      let out = ''
      for (let i = 0; i < arguments.length; i++) {
        const value = arguments[i]
        if (value) out += (out ? ' ' : '') + value
      }
      return out
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function uid(prefix) {
      const body =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
          : Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
      return `${prefix}_${body}`
    }

    function readLS(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch {
        return fallback
      }
    }

    function writeLS(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* storage may be disabled; the board still lives on the host */
      }
    }

    function formatTime(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString(LANG === 'zh' ? 'zh-CN' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    function formatDate(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleDateString(LANG === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short',
        day: 'numeric',
      })
    }

    function errorText(error) {
      const message = String((error && error.message) || error || '')
      if (message === 'Failed to fetch') {
        return L('无法连接 DSH 宿主，请确认应用仍在运行。', 'Cannot reach the DSH host. Is the app still running?')
      }
      return message || L('未知错误', 'Unknown error')
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
          const wrote = await Promise.race([
            navigator.clipboard.writeText(text).then(() => true).catch(() => false),
            new Promise((resolve) => setTimeout(() => resolve(false), 800)),
          ])
          if (wrote) return true
        }
      } catch {
        /* fall through */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.left = '-1000px'
        area.style.width = '1px'
        area.style.height = '1px'
        area.style.opacity = '0.01'
        area.style.pointerEvents = 'none'
        document.body.appendChild(area)
        area.focus()
        area.select()
        area.setSelectionRange(0, text.length)
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return !!ok
      } catch {
        return false
      }
    }

    async function api(path, options) {
      const opts = options || {}
      const init = { method: opts.method || 'GET', cache: 'no-store' }
      if (opts.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      }
      const response = await fetch(API + path, init)
      const text = await response.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!response.ok) {
        const detail = data && (data.message || data.error)
        throw new Error(detail || `HTTP ${response.status}`)
      }
      return data
    }

    async function streamChat(payload, signal, onEvent) {
      const response = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok) {
        const text = await response.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = null
        }
        throw new Error((data && (data.message || data.error)) || `HTTP ${response.status}`)
      }
      if (!response.body) throw new Error(L('当前环境不支持流式响应。', 'Streaming is unavailable in this environment.'))
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) {
            let event = null
            try {
              event = JSON.parse(line)
            } catch {
              event = null
            }
            if (event) onEvent(event)
          }
          index = buffer.indexOf('\n')
        }
      }
      const tail = buffer.trim()
      if (tail) {
        try {
          onEvent(JSON.parse(tail))
        } catch {
          /* ignore a truncated tail */
        }
      }
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    const ICON_PATHS = {
      plus: ['M12 5v14', 'M5 12h14'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      chevron: ['M6 9l6 6 6-6'],
      branch: ['M6 4v7a4 4 0 0 0 4 4h8', 'M14 11l4 4-4 4', 'M6 4h.01'],
      send: ['M4 12l16-8-6 16-3-6-7-2z'],
      stop: ['M7 7h10v10H7z'],
      refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
      trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
      copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
      expand: ['M9 3H3v6', 'M3 3l7 7', 'M15 21h6v-6', 'M21 21l-7-7'],
      grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
      fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
      help: ['M12 18h.01', 'M9.1 9a3 3 0 1 1 5.2 2c-.8.8-1.8 1.3-2.3 2.4', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
      focus: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4'],
      quote: ['M7 8h4v4c0 3-2 5-4 6', 'M15 8h4v4c0 3-2 5-4 6'],
      check: ['M5 12l4 4L19 6'],
      user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 21a7.5 7.5 0 0 1 15 0'],
      bot: ['M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3z', 'M12 4v4', 'M9 13h.01', 'M15 13h.01', 'M9.5 16h5'],
      spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'],
      map: ['M9 4l6 2 6-2v14l-6 2-6-2-6 2V6z', 'M9 4v14', 'M15 6v14'],
      warning: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
      clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
      arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
      dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
      layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5', 'M3 17l9 5 9-5'],
      paperclip: ['M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-2.8-2.8l8.2-8.2'],
      file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
      download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
      document: ['M7 3h7l4 4v14H7z', 'M14 3v5h5', 'M9 12h6', 'M9 16h6'],
      image: ['M4 4h16v16H4z', 'M8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M4 16l5-5 4 4 3-3 4 4'],
    }

    function Icon({ name, size = 18, className, strokeWidth = 1.8 }) {
      const paths = ICON_PATHS[name] || ICON_PATHS.spark
      return h(
        'svg',
        {
          className: cls('cc-icon', className),
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths.map((d, index) => h('path', { key: index, d }))
      )
    }

    function BrandMark({ size = 26 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': 'true', className: 'cc-brandmark' },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'cc-brand-grad', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0', stopColor: '#5b8cff' }),
            h('stop', { offset: '0.55', stopColor: '#8b5cff' }),
            h('stop', { offset: '1', stopColor: '#20c7b7' })
          )
        ),
        h('rect', { x: '1', y: '1', width: '30', height: '30', rx: '9', fill: 'url(#cc-brand-grad)' }),
        h('path', {
          d: 'M9 10.5 C 13 10.5, 13 16, 17 16 C 21 16, 21 21.5, 24 21.5',
          fill: 'none',
          stroke: '#fff',
          strokeOpacity: '0.9',
          strokeWidth: '1.6',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M17 16 C 20.5 16, 20 11, 23.5 11',
          fill: 'none',
          stroke: '#fff',
          strokeOpacity: '0.65',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
        }),
        h('circle', { cx: '8.5', cy: '10.5', r: '2.4', fill: '#fff' }),
        h('circle', { cx: '17', cy: '16', r: '2', fill: '#fff' }),
        h('circle', { cx: '24', cy: '21.5', r: '2.4', fill: '#fff' }),
        h('circle', { cx: '23.5', cy: '11', r: '1.7', fill: '#fff', fillOpacity: '0.9' })
      )
    }

    /* ------------------------------------------------------------------ */
    /* Attachments                                                         */
    /* ------------------------------------------------------------------ */

    function describeWords(words) {
      const value = Number(words) || 0
      if (!value) return ''
      if (value >= 10000) return `${(value / 10000).toFixed(1)} 万字`
      return `${value} 字`
    }

    function attachmentMeta(item) {
      if (!item) return ''
      if (item.docType === 'pptx') {
        const slides = Number(item.meta && item.meta.slides) || 0
        return slides ? `PPT · ${slides} 页` : 'PPT'
      }
      if (item.docType === 'docx') {
        const words = describeWords(item.meta && item.meta.words)
        return words ? `Word · ${words}` : 'Word'
      }
      return describeSize(item.size)
    }

    function AttachmentTray({ items, onRemove, uploading, compact }) {
      const list = Array.isArray(items) ? items : []
      if (!list.length && !uploading) return null
      return h(
        'div',
        { className: cls('cc-attachments', compact && 'is-compact') },
        list.map((item) => {
          const isImage = item.kind === 'image'
          const isDocument = item.docType === 'docx' || item.docType === 'pptx'
          return h(
            'div',
            { key: item.id, className: cls('cc-attach-item', isImage ? 'is-image' : 'is-file', isDocument && 'is-document') },
            isImage
              ? h('img', {
                  src: attachmentUrl(item),
                  alt: item.name || L('图片', 'Image'),
                  loading: 'lazy',
                  title: item.name || '',
                  onClick: () => window.open(attachmentUrl(item), '_blank', 'noopener'),
                })
              : h(
                  React.Fragment,
                  null,
                  h(
                    'span',
                    { className: 'cc-attach-icon' },
                    h(Icon, { name: item.docType === 'pptx' ? 'layers' : 'file', size: 15 })
                  ),
                  h(
                    'span',
                    { className: 'cc-attach-name', title: item.name || '' },
                    h('span', null, item.name || L('文本文件', 'Text file')),
                    h('span', { className: 'cc-attach-size' }, attachmentMeta(item))
                  )
                ),
            isDocument && item.truncated
              ? h('span', { className: 'cc-attach-truncated', title: L('内容较长，进入上下文时已截断', 'Long content was truncated for context') }, L('截断', 'trimmed'))
              : null,
            onRemove
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-attach-remove',
                    title: L('移除附件', 'Remove attachment'),
                    'aria-label': L('移除附件', 'Remove attachment'),
                    onClick: (event) => {
                      event.stopPropagation()
                      onRemove(item.id)
                    },
                  },
                  h(Icon, { name: 'close', size: 11 })
                )
              : null
          )
        }),
        uploading
          ? h('div', { className: 'cc-attach-item is-loading', title: L('正在上传…', 'Uploading…') }, h(ThinkingDots))
          : null
      )
    }

    function AttachmentButton({ onFiles, disabled, title }) {
      const inputRef = useRef(null)
      return h(
        React.Fragment,
        null,
        h('input', {
          ref: inputRef,
          type: 'file',
          multiple: true,
          accept: ACCEPT_ATTR,
          className: 'cc-file-input',
          tabIndex: -1,
          onChange: (event) => {
            const files = Array.from(event.target.files || [])
            event.target.value = ''
            if (files.length) onFiles(files)
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'cc-iconbtn',
            title: title || L('添加图片、文本、Word 或 PPT', 'Attach image, text, Word or PowerPoint'),
            'aria-label': title || L('添加图片、文本、Word 或 PPT', 'Attach image, text, Word or PowerPoint'),
            disabled: !!disabled,
            onClick: () => inputRef.current && inputRef.current.click(),
          },
          h(Icon, { name: 'paperclip', size: 16 })
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Markdown (small, safe, dependency-free)                             */
    /* ------------------------------------------------------------------ */

    function textWithBreaks(text, prefix) {
      const parts = String(text).split('\n')
      const out = []
      parts.forEach((part, index) => {
        if (index > 0) out.push(h('br', { key: `${prefix}-br-${index}` }))
        if (part) out.push(part)
      })
      return out
    }

    function renderInline(text) {
      const source = String(text == null ? '' : text)
      const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g
      const parts = []
      let cursor = 0
      let match
      let key = 0
      while ((match = pattern.exec(source))) {
        if (match.index > cursor) {
          parts.push(h(React.Fragment, { key: `t${key++}` }, textWithBreaks(source.slice(cursor, match.index), `t${key}`)))
        }
        const token = match[0]
        if (token.startsWith('**')) {
          parts.push(h('strong', { key: `b${key++}` }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          parts.push(h('code', { key: `c${key++}`, className: 'cc-inline-code' }, token.slice(1, -1)))
        } else if (token.startsWith('[')) {
          const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
          if (linkMatch && /^https?:\/\//i.test(linkMatch[2])) {
            parts.push(
              h(
                'a',
                { key: `a${key++}`, href: linkMatch[2], target: '_blank', rel: 'noreferrer noopener' },
                linkMatch[1]
              )
            )
          } else if (linkMatch) {
            parts.push(linkMatch[1])
          } else {
            parts.push(token)
          }
        } else {
          parts.push(h('em', { key: `i${key++}` }, token.slice(1, -1)))
        }
        cursor = match.index + token.length
      }
      if (cursor < source.length) {
        parts.push(h(React.Fragment, { key: `t${key++}` }, textWithBreaks(source.slice(cursor), `tail${key}`)))
      }
      return parts
    }

    function isBlockStart(line) {
      return (
        /^```/.test(line) ||
        /^#{1,4}\s+/.test(line) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
        /^>\s?/.test(line) ||
        /^\s*([-*_]\s*){3,}$/.test(line)
      )
    }

    function CodeBlock({ code, lang }) {
      const [copyState, setCopyState] = useState('idle')
      const copy = () => {
        copyText(code).then((ok) => {
          setCopyState(ok ? 'ok' : 'fail')
          setTimeout(() => setCopyState('idle'), 1800)
        })
      }
      return h(
        'div',
        { className: 'cc-code' },
        h(
          'div',
          { className: 'cc-code-head' },
          h('span', { className: 'cc-code-lang' }, lang || 'code'),
          h(
            'button',
            { className: 'cc-code-copy', type: 'button', onClick: copy },
            h(Icon, { name: copyState === 'ok' ? 'check' : copyState === 'fail' ? 'warning' : 'copy', size: 13 }),
            copyState === 'ok' ? L('已复制', 'Copied') : copyState === 'fail' ? L('复制失败', 'Copy failed') : L('复制', 'Copy')
          )
        ),
        h('pre', null, h('code', null, code))
      )
    }

    function parseMarkdown(text) {
      const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n')
      const blocks = []
      let index = 0
      let key = 0
      while (index < lines.length) {
        const line = lines[index]
        if (!line.trim()) {
          index += 1
          continue
        }
        if (/^```/.test(line)) {
          const lang = line.slice(3).trim()
          index += 1
          const body = []
          while (index < lines.length && !/^```/.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h(CodeBlock, { key: key++, code: body.join('\n'), lang }))
          continue
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading) {
          const level = Math.min(5, heading[1].length + 1)
          blocks.push(h(`h${level}`, { key: key++ }, renderInline(heading[2])))
          index += 1
          continue
        }
        if (/^\s*([-*_]\s*){3,}$/.test(line)) {
          blocks.push(h('hr', { key: key++ }))
          index += 1
          continue
        }
        if (/^>\s?/.test(line)) {
          const body = []
          while (index < lines.length && /^>\s?/.test(lines[index])) {
            body.push(lines[index].replace(/^>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: key++ }, h(Markdown, { text: body.join('\n') })))
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
            items.push(lines[index].replace(/^\s*[-*+]\s+/, ''))
            index += 1
          }
          blocks.push(
            h('ul', { key: key++ }, items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item))))
          )
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
            items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''))
            index += 1
          }
          blocks.push(
            h('ol', { key: key++ }, items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item))))
          )
          continue
        }
        if (
          /^\s*\|.*\|\s*$/.test(line) &&
          index + 1 < lines.length &&
          /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])
        ) {
          const cells = line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim())
          index += 2
          const rows = []
          while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
            const row = lines[index]
              .trim()
              .replace(/^\|/, '')
              .replace(/\|$/, '')
              .split('|')
              .map((cell) => cell.trim())
            rows.push(row)
            index += 1
          }
          blocks.push(
            h(
              'div',
              { key: key++, className: 'cc-table-wrap' },
              h(
                'table',
                null,
                h('thead', null, h('tr', null, cells.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(cell))))),
                h(
                  'tbody',
                  null,
                  rows.map((row, rowIndex) =>
                    h(
                      'tr',
                      { key: rowIndex },
                      row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(cell)))
                    )
                  )
                )
              )
            )
          )
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push(h('p', { key: key++ }, renderInline(paragraph.join('\n'))))
      }
      return blocks
    }

    function Markdown({ text }) {
      const blocks = useMemo(() => parseMarkdown(text), [text])
      return h('div', { className: 'cc-md' }, blocks)
    }

    /* ------------------------------------------------------------------ */
    /* Canvas geometry                                                     */
    /* ------------------------------------------------------------------ */

    function nodeMapOf(nodes) {
      const map = new Map()
      nodes.forEach((node) => map.set(node.id, node))
      return map
    }

    function pathTo(nodes, id) {
      const map = nodeMapOf(nodes)
      const chain = []
      let current = map.get(id)
      let guard = 0
      while (current && guard < 400) {
        chain.unshift(current)
        current = current.parentId ? map.get(current.parentId) : null
        guard += 1
      }
      return chain
    }

    function buildMessages(nodes, parentId) {
      const messages = []
      pathTo(nodes, parentId).forEach((node) => {
        const attachments = Array.isArray(node.attachments) ? node.attachments.slice(0, MAX_ATTACHMENTS) : []
        if (node.prompt || attachments.length) {
          messages.push({ role: 'user', content: node.prompt || '', attachments })
        }
        if (node.answer) messages.push({ role: 'assistant', content: node.answer })
      })
      return messages
    }

    function descendantsOf(nodes, id) {
      const out = new Set([id])
      let changed = true
      while (changed) {
        changed = false
        nodes.forEach((node) => {
          if (node.parentId && out.has(node.parentId) && !out.has(node.id)) {
            out.add(node.id)
            changed = true
          }
        })
      }
      return out
    }

    function isAsideNode(node) {
      return !!(node && node.kind === 'aside')
    }

    function asideMessages(node) {
      if (!node) return []
      if (Array.isArray(node.messages) && node.messages.length) return node.messages
      if (node.prompt || node.answer) {
        return [
          ...(node.prompt ? [{ role: 'user', content: node.prompt }] : []),
          ...(node.answer ? [{ role: 'assistant', content: node.answer }] : []),
        ]
      }
      return []
    }

    function asideQuestion(node) {
      const first = asideMessages(node).find((message) => message.role === 'user')
      return (first && first.content) || (node && node.prompt) || ''
    }

    function asidePreview(node) {
      const all = asideMessages(node)
      for (let index = all.length - 1; index >= 0; index -= 1) {
        if (all[index].role === 'assistant' && all[index].content) return all[index].content
      }
      return (node && node.answer) || ''
    }

    function plainPreview(text) {
      return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/^[ \t]*[-+*][ \t]+/gm, '')
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/[*_#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function asideTranscript(node) {
      const lines = []
      if (node && node.quote) {
        lines.push(`> ${L('选中片段：', 'Selected passage: ')}${String(node.quote).replace(/\n/g, '\n> ')}`)
      }
      asideMessages(node).forEach((message) => {
        if (!message || !message.content) return
        lines.push(`### ${message.role === 'user' ? L('你', 'You') : L('临时回答', 'Side answer')}`)
        lines.push('')
        lines.push(String(message.content))
        lines.push('')
      })
      return lines.join('\n').trim() || (node && node.answer) || ''
    }

    function layoutTree(nodes) {
      const map = nodeMapOf(nodes)
      const regularNodes = nodes.filter((node) => !isAsideNode(node))
      const asideNodes = nodes.filter((node) => isAsideNode(node))
      const children = new Map()
      const roots = []
      regularNodes.forEach((node) => {
        if (node.parentId && map.has(node.parentId)) {
          if (!children.has(node.parentId)) children.set(node.parentId, [])
          children.get(node.parentId).push(node)
        } else {
          roots.push(node)
        }
      })
      roots.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      const positions = {}
      let cursorY = 0
      const xGap = NODE_W + 150
      const yGap = NODE_H + 64
      const walk = (node, depth) => {
        const kids = children.get(node.id) || []
        if (!kids.length) {
          const y = cursorY
          cursorY += yGap
          positions[node.id] = { x: depth * xGap, y }
          return y
        }
        const ys = kids.map((kid) => walk(kid, depth + 1))
        const y = (ys[0] + ys[ys.length - 1]) / 2
        positions[node.id] = { x: depth * xGap, y }
        return y
      }
      roots.forEach((root) => {
        walk(root, 0)
        cursorY += 40
      })
      const offset = cursorY / 2 - NODE_H / 2
      Object.keys(positions).forEach((id) => {
        positions[id].y -= offset
      })

      // Saved side threads stay visually attached to their source node but do
      // not participate in the main tree layout.
      const placed = regularNodes.map((node) => ({ x: positions[node.id].x, y: positions[node.id].y }))
      asideNodes.forEach((aside) => {
        const anchor = aside.anchorId ? map.get(aside.anchorId) : null
        const anchorPos = anchor ? positions[anchor.id] || { x: anchor.x, y: anchor.y } : null
        let x = anchorPos ? anchorPos.x : 0
        let y = anchorPos ? anchorPos.y + NODE_H + 72 : cursorY
        let guard = 0
        while (guard < 80) {
          const hit = placed.some(
            (spot) => Math.abs(spot.x - x) < NODE_W + 34 && Math.abs(spot.y - y) < NODE_H + 28
          )
          if (!hit) break
          y += NODE_H + 42
          guard += 1
        }
        positions[aside.id] = { x, y }
        placed.push({ x, y })
      })
      return positions
    }

    function collides(nodes, x, y, ignoreId) {
      return nodes.some((node) => {
        if (ignoreId && node.id === ignoreId) return false
        return Math.abs(node.x - x) < NODE_W + 34 && Math.abs(node.y - y) < NODE_H + 28
      })
    }

    function dropSlot(nodes, x, y) {
      let nextY = y
      let guard = 0
      while (guard < 120) {
        const hits = nodes.filter(
          (node) => Math.abs(node.x - x) < NODE_W + 34 && Math.abs(node.y - nextY) < NODE_H + 28
        )
        if (!hits.length) break
        nextY = Math.max.apply(null, hits.map((node) => node.y + NODE_H)) + 46
        guard += 1
      }
      return { x, y: nextY }
    }

    function childSlot(parent, nodes) {
      return dropSlot(nodes, parent.x + NODE_W + 150, parent.y)
    }

    function rootSlot(nodes, stageSize, viewport) {
      const width = stageSize.w || 1200
      const height = stageSize.h || 800
      const x = (width / 2 - viewport.x) / viewport.scale - NODE_W / 2
      const y = (height / 2 - viewport.y) / viewport.scale - NODE_H / 2 - 30
      return dropSlot(nodes, x, y)
    }

    function fitViewport(nodes, stageSize) {
      const width = stageSize.w || 1200
      const height = stageSize.h || 800
      if (!nodes.length) return { x: width / 2 - NODE_W / 2, y: height / 2 - NODE_H / 2, scale: 0.9 }
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      nodes.forEach((node) => {
        minX = Math.min(minX, node.x)
        minY = Math.min(minY, node.y)
        maxX = Math.max(maxX, node.x + NODE_W)
        maxY = Math.max(maxY, node.y + NODE_H)
      })
      const pad = 92
      const scale = clamp(
        Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY)),
        MIN_SCALE,
        1.05
      )
      return {
        x: (width - (maxX - minX) * scale) / 2 - minX * scale,
        y: (height - (maxY - minY) * scale) / 2 - minY * scale,
        scale,
      }
    }

    /* ------------------------------------------------------------------ */
    /* Small UI pieces                                                     */
    /* ------------------------------------------------------------------ */

    function ThinkingDots() {
      return h(
        'span',
        { className: 'cc-thinking', 'aria-label': L('思考中', 'Thinking') },
        h('i', null),
        h('i', null),
        h('i', null)
      )
    }

    function Modal({ title, subtitle, onClose, children, width }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        {
          className: 'cc-backdrop',
          onPointerDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            className: 'cc-modal',
            style: width ? { width } : null,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h(
            'div',
            { className: 'cc-modal-head' },
            h(
              'div',
              { className: 'cc-modal-heading' },
              h('div', { className: 'cc-modal-title' }, title),
              subtitle ? h('div', { className: 'cc-modal-sub' }, subtitle) : null
            ),
            h(
              'button',
              { type: 'button', className: 'cc-iconbtn', onClick: onClose, title: L('关闭', 'Close') },
              h(Icon, { name: 'close' })
            )
          ),
          children
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Node card                                                           */
    /* ------------------------------------------------------------------ */

    const NodeCard = React.memo(function NodeCard(props) {
      const {
        node,
        selected,
        dimmed,
        hasAside,
        isRoot,
        modelLabel,
        onSelect,
        onDragStart,
        onBranch,
        onRegenerate,
        onStop,
        onDelete,
        onExpand,
        onFocus,
        onTextSelect,
        onContinueAside,
        onExport,
      } = props
      const answerRef = useRef(null)
      const wasStreaming = useRef(node.streaming)

      useEffect(() => {
        if (node.streaming && answerRef.current) {
          answerRef.current.scrollTop = answerRef.current.scrollHeight
        }
        if (wasStreaming.current && !node.streaming && answerRef.current) {
          answerRef.current.scrollTop = 0
        }
        wasStreaming.current = node.streaming
      }, [node.answer, node.streaming])

      const hasAnswer = !!node.answer
      if (isAsideNode(node)) {
        const messages = asideMessages(node)
        const preview = plainPreview(asidePreview(node))
        const turns = messages.filter((message) => message.role === 'assistant' && message.content).length
        return h(
          'div',
          {
            className: cls(
              'cc-node',
              'cc-aside-card',
              selected && 'is-selected',
              dimmed && 'is-dimmed',
              node.error && 'has-error'
            ),
            style: { transform: `translate3d(${node.x}px, ${node.y}px, 0)` },
            onPointerDown: (event) => {
              if (event.button !== 0 && event.button !== 1) return
              if (event.target.closest('button') || event.target.closest('a')) return
              onSelect(node.id)
              if (event.target.closest('.cc-node-head') || event.target.closest('.cc-node-grip')) {
                onDragStart(event, node)
              }
            },
            onDoubleClick: () => onExpand(node.id),
            onWheel: (event) => event.stopPropagation(),
            'data-node-id': node.id,
          },
          h(
            'div',
            { className: 'cc-node-head cc-aside-card-head' },
            h(
              'span',
              { className: 'cc-node-badge cc-aside-badge' },
              h(Icon, { name: 'quote', size: 13 })
            ),
            h(
              'div',
              { className: 'cc-node-meta' },
              h('span', { className: 'cc-node-kind' }, L('临时对话', 'SIDE THREAD')),
              h(
                'span',
                { className: 'cc-aside-saved-tag' },
                h(Icon, { name: 'check', size: 11 }),
                L('已保存到画布', 'Saved to canvas')
              )
            ),
            h(
              'div',
              { className: 'cc-node-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'cc-iconbtn',
                  title: L('聚焦这段临时对话', 'Focus this side thread'),
                  onClick: (event) => {
                    event.stopPropagation()
                    onFocus(node.id)
                  },
                },
                h(Icon, { name: 'focus', size: 14 })
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cc-iconbtn',
                  title: L('查看完整临时对话', 'Read side thread'),
                  onClick: (event) => {
                    event.stopPropagation()
                    onExpand(node.id)
                  },
                },
                h(Icon, { name: 'expand', size: 14 })
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cc-iconbtn is-danger',
                  title: L('删除这段临时对话', 'Delete side thread'),
                  onClick: (event) => {
                    event.stopPropagation()
                    onDelete(node.id)
                  },
                },
                h(Icon, { name: 'trash', size: 14 })
              )
            )
          ),
          h(
            'div',
            { className: 'cc-node-prompt cc-aside-card-prompt' },
            h('span', { className: 'cc-node-grip', title: L('拖动', 'Drag') }, h(Icon, { name: 'dots', size: 14 })),
            h(
              'div',
              { className: 'cc-aside-card-quote' },
              h('span', { className: 'cc-aside-card-quote-label' }, L('选中片段', 'Selected passage')),
              h('span', { className: 'cc-aside-card-quote-text' }, node.quote || asideQuestion(node) || L('（未记录选中片段）', '(no passage recorded)'))
            )
          ),
          h(
            'div',
            { className: 'cc-aside-card-thread' },
            h(
              'div',
              { className: 'cc-aside-card-thread-meta' },
              h(Icon, { name: 'quote', size: 12 }),
              turns ? L(`${turns} 轮临时问答`, `${turns} side ${turns === 1 ? 'answer' : 'answers'}`) : L('临时问答', 'Side thread')
            ),
            preview
              ? h('div', { className: 'cc-aside-card-preview' }, preview)
              : h('div', { className: 'cc-aside-card-preview cc-muted' }, L('（没有回答）', '(no answer)'))
          ),
          h(
              'div',
              { className: 'cc-node-foot cc-aside-card-foot' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'cc-node-continue cc-aside-continue',
                  onClick: (event) => {
                    event.stopPropagation()
                    onContinueAside(node.id)
                  },
                },
                h(Icon, { name: 'quote', size: 13 }),
                L('继续追问', 'Continue')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cc-node-continue cc-aside-open',
                  onClick: (event) => {
                    event.stopPropagation()
                    onExpand(node.id)
                  },
                },
                h(Icon, { name: 'expand', size: 13 }),
                L('查看全文', 'Open')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cc-node-export is-aside',
                  title: L('导出这段临时对话', 'Export this side thread'),
                  onClick: (event) => {
                    event.stopPropagation()
                    onExport(node.id)
                  },
                },
                h(Icon, { name: 'download', size: 12 }),
                L('导出', 'Export')
              ),
              h('span', { className: 'cc-node-time' }, formatTime(node.updatedAt || node.createdAt))
            )
        )
      }
      return h(
        'div',
        {
          className: cls(
            'cc-node',
            selected && 'is-selected',
            dimmed && 'is-dimmed',
            node.streaming && 'is-streaming',
            node.error && 'has-error',
            isRoot && 'is-root',
            hasAside && 'has-aside'
          ),
          style: { transform: `translate3d(${node.x}px, ${node.y}px, 0)` },
          onPointerDown: (event) => {
            if (event.button !== 0 && event.button !== 1) return
            if (event.target.closest('button') || event.target.closest('a')) return
            onSelect(node.id)
            if (event.target.closest('.cc-node-head') || event.target.closest('.cc-node-grip')) {
              onDragStart(event, node)
            }
          },
          onDoubleClick: () => onExpand(node.id),
          onWheel: (event) => event.stopPropagation(),
          'data-node-id': node.id,
        },
        h(
          'div',
          { className: 'cc-node-head' },
          h(
            'span',
            { className: cls('cc-node-badge', isRoot ? 'is-root' : 'is-child') },
            h(Icon, { name: isRoot ? 'spark' : 'branch', size: 13 })
          ),
          h(
            'div',
            { className: 'cc-node-meta' },
            h('span', { className: 'cc-node-kind' }, isRoot ? L('起点', 'Root') : L('分支', 'Branch')),
            hasAside ? h('span', { className: 'cc-node-aside-tag' }, L('临时', 'Side')) : null,
            h('span', { className: 'cc-node-model', title: `${node.provider || ''} / ${node.model || ''}` }, modelLabel || node.model || L('未选模型', 'No model'))
          ),
          h(
            'div',
            { className: 'cc-node-actions' },
            node.streaming
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-iconbtn is-danger',
                    title: L('停止生成', 'Stop'),
                    onClick: (event) => {
                      event.stopPropagation()
                      onStop(node.id)
                    },
                  },
                  h(Icon, { name: 'stop', size: 14 })
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'cc-iconbtn',
                title: L('重新生成', 'Regenerate'),
                onClick: (event) => {
                  event.stopPropagation()
                  onRegenerate(node.id)
                },
              },
              h(Icon, { name: 'refresh', size: 14 })
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-iconbtn',
                title: L('聚焦这个分支', 'Focus this branch'),
                onClick: (event) => {
                  event.stopPropagation()
                  onFocus(node.id)
                },
              },
              h(Icon, { name: 'focus', size: 14 })
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-iconbtn',
                title: L('放大阅读', 'Read'),
                onClick: (event) => {
                  event.stopPropagation()
                  onExpand(node.id)
                },
              },
              h(Icon, { name: 'expand', size: 14 })
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-iconbtn is-danger',
                title: L('删除这个分支', 'Delete branch'),
                onClick: (event) => {
                  event.stopPropagation()
                  onDelete(node.id)
                },
              },
              h(Icon, { name: 'trash', size: 14 })
            )
          )
        ),
        h(
          'div',
          { className: 'cc-node-prompt' },
          h('span', { className: 'cc-node-grip', title: L('拖动', 'Drag') }, h(Icon, { name: 'dots', size: 14 })),
          h('div', { className: 'cc-node-prompt-text' }, node.prompt || h('span', { className: 'cc-muted' }, L('（空）', '(empty)'))
          )
        ),
        h(AttachmentTray, { items: node.attachments || [], compact: true }),
        node.reasoning
          ? h(
              'details',
              { className: 'cc-reasoning' },
              h('summary', null, h(Icon, { name: 'spark', size: 12 }), L('思考过程', 'Reasoning')),
              h('div', { className: 'cc-reasoning-body' }, node.reasoning)
            )
          : null,
        h(
          'div',
          {
            className: 'cc-node-answer',
            ref: answerRef,
            onMouseUp: (event) => onTextSelect(node.id, event.currentTarget),
            onKeyUp: (event) => {
              if (event.shiftKey || event.key === 'Shift') onTextSelect(node.id, event.currentTarget)
            },
          },
          node.error
            ? h(
                'div',
                { className: 'cc-node-error' },
                h(Icon, { name: 'warning', size: 14 }),
                h('div', null, h('div', { className: 'cc-node-error-title' }, L('这次没有成功', 'Request failed')), h('div', { className: 'cc-node-error-text' }, node.error))
              )
            : hasAnswer
              ? h(
                  React.Fragment,
                  null,
                  h(Markdown, { text: node.answer }),
                  node.streaming ? h('span', { className: 'cc-caret' }) : null
                )
              : node.streaming
                ? h(
                    'div',
                    { className: 'cc-node-waiting' },
                    h(ThinkingDots),
                    h('span', null, L('正在展开这个分支…', 'Growing this branch…'))
                  )
                : h('div', { className: 'cc-node-placeholder' }, L('还没有回答。点下面的「从这里继续」，或重新生成。', 'No answer yet. Continue from here or regenerate.'))
        ),
        h(
          'div',
          { className: 'cc-node-foot' },
          h(
            'button',
            {
              type: 'button',
              className: 'cc-node-continue',
              onClick: (event) => {
                event.stopPropagation()
                onBranch(node.id)
              },
            },
            h(Icon, { name: 'branch', size: 14 }),
            L('从这里继续', 'Continue here')
          ),
          h(
              'button',
              {
                type: 'button',
                className: 'cc-node-export',
                title: L('导出 Word / PPT', 'Export Word / PowerPoint'),
                onClick: (event) => {
                  event.stopPropagation()
                  onExport(node.id)
                },
              },
              h(Icon, { name: 'download', size: 12 }),
              L('导出', 'Export')
            ),
            h('span', { className: 'cc-node-time' }, formatTime(node.updatedAt || node.createdAt)),
          node.usage
            ? h('span', { className: 'cc-node-usage', title: L('Token 用量', 'Token usage') }, `${node.usage.outputTokens || 0} tok`)
            : null
        )
      )
    })

    /* ------------------------------------------------------------------ */
    /* Model picker                                                        */
    /* ------------------------------------------------------------------ */

    function ModelModal({ catalog, value, onPick, onClose }) {
      const [query, setQuery] = useState('')
      const [custom, setCustom] = useState(false)
      const [customProvider, setCustomProvider] = useState((value && value.provider) || '')
      const [customModel, setCustomModel] = useState((value && value.model) || '')

      const providers = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = (catalog.providers || [])
          .map((provider) => ({
            ...provider,
            models: (provider.models || [])
              .filter(
                (model) =>
                  !q ||
                  String(model.name || '').toLowerCase().includes(q) ||
                  String(model.id || '').toLowerCase().includes(q) ||
                  String(provider.name || '').toLowerCase().includes(q)
              )
              .sort((a, b) => {
                const active = (model) => (value && value.provider === provider.id && value.model === model.id ? 1 : 0)
                return active(b) - active(a)
              }),
          }))
          .filter((provider) => provider.models.length > 0)
        if (value && value.provider) {
          list.sort((a, b) => Number(b.id === value.provider) - Number(a.id === value.provider))
        }
        return list
      }, [catalog.providers, query, value])

      const total = (catalog.providers || []).reduce((sum, provider) => sum + (provider.models || []).length, 0)

      return h(
        Modal,
        {
          title: L('选择模型', 'Choose a model'),
          subtitle: L('列表直接来自 DSH 当前配置的模型提供方，插件不保存任何密钥。', 'The list comes from the model providers configured in DSH. No keys are stored by this plugin.'),
          onClose,
          width: 640,
        },
        h(
          'div',
          { className: 'cc-model-body' },
          h(
            'div',
            { className: 'cc-search' },
            h(Icon, { name: 'search', size: 16 }),
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: L('搜索模型或提供方…', 'Search provider or model…'),
              autoFocus: true,
            }),
            query
              ? h(
                  'button',
                  { type: 'button', className: 'cc-iconbtn', onClick: () => setQuery('') },
                  h(Icon, { name: 'close', size: 14 })
                )
              : null
          ),
          h(
            'div',
            { className: 'cc-model-scroll' },
            !catalog.hasLlm
              ? h(
                  'div',
                  { className: 'cc-empty-note' },
                  h(Icon, { name: 'warning', size: 18 }),
                  h('div', null, h('strong', null, L('还没有可用的模型服务', 'No model service available')), h('p', null, L('请先在 DSH 设置中配置并启用一个模型提供方，然后回到这里。', 'Configure and enable a model provider in DSH settings first, then come back.')))
                )
              : providers.length
                ? providers.map((provider) =>
                    h(
                      'div',
                      { key: provider.id, className: 'cc-model-group' },
                      h(
                        'div',
                        { className: 'cc-model-provider' },
                        h('span', null, provider.name || provider.id),
                        provider.name && provider.name !== provider.id
                          ? h('span', { className: 'cc-model-provider-id' }, provider.id)
                          : null
                      ),
                      (provider.models || []).map((model) => {
                        const active = value && value.provider === provider.id && value.model === model.id
                        return h(
                          'button',
                          {
                            key: `${provider.id}/${model.id}`,
                            type: 'button',
                            className: cls('cc-model-row', active && 'is-active'),
                            onClick: () => onPick({ provider: provider.id, model: model.id }),
                          },
                          h(
                            'div',
                            { className: 'cc-model-row-main' },
                            h('span', { className: 'cc-model-name' }, model.name || model.id),
                            model.name && model.name !== model.id
                              ? h('span', { className: 'cc-model-id' }, model.id)
                              : null
                          ),
                          active ? h(Icon, { name: 'check', size: 16 }) : null
                        )
                      })
                    )
                  )
                : h(
                    'div',
                    { className: 'cc-empty-note' },
                    h(Icon, { name: 'search', size: 18 }),
                    h('div', null, h('strong', null, L('没有匹配的模型', 'No matching model')), h('p', null, L('换个关键词，或在下面手动输入模型路由。', 'Try another search, or enter a route manually below.')))
                  )
          ),
          h(
            'div',
            { className: 'cc-model-foot' },
            h(
              'button',
              { type: 'button', className: 'cc-linkbtn', onClick: () => setCustom((prev) => !prev) },
              custom ? L('收起手动输入', 'Hide manual entry') : L('找不到？手动输入模型路由', 'Missing? Enter a route manually')
            ),
            h('span', { className: 'cc-model-count' }, L(`${total} 个模型 · DSH 已连接`, `${total} models · from DSH`))
          ),
          custom
            ? h(
                'div',
                { className: 'cc-custom-route' },
                h('input', {
                  value: customProvider,
                  onChange: (event) => setCustomProvider(event.target.value),
                  placeholder: L('provider，例如 deepseek', 'provider, e.g. deepseek'),
                  'aria-label': 'provider',
                }),
                h('input', {
                  value: customModel,
                  onChange: (event) => setCustomModel(event.target.value),
                  placeholder: L('model，例如 deepseek-chat', 'model, e.g. deepseek-chat'),
                  'aria-label': 'model',
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-primary is-small',
                    disabled: !customProvider.trim() || !customModel.trim(),
                    onClick: () => onPick({ provider: customProvider.trim(), model: customModel.trim() }),
                  },
                  L('使用', 'Use')
                )
              )
            : null
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Board picker                                                        */
    /* ------------------------------------------------------------------ */

    function BoardModal({ boards, current, onOpen, onCreate, onDelete, onRename, onClose }) {
      const [title, setTitle] = useState((current && current.title) || '')
      const [confirmId, setConfirmId] = useState(null)
      useEffect(() => setTitle((current && current.title) || ''), [current && current.id])

      return h(
        Modal,
        {
          title: L('我的画布', 'My canvases'),
          subtitle: L('每个画布是一棵独立的对话树，保存在本机 DSH 数据目录中。', 'Each canvas is its own conversation tree, stored locally in DSH data.'),
          onClose,
          width: 620,
        },
        h(
          'div',
          { className: 'cc-board-body' },
          current
            ? h(
                'div',
                { className: 'cc-rename' },
                h('input', {
                  value: title,
                  onChange: (event) => setTitle(event.target.value),
                  placeholder: L('画布名称', 'Canvas name'),
                  'aria-label': L('画布名称', 'Canvas name'),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-secondary',
                    disabled: !title.trim() || title.trim() === current.title,
                    onClick: () => onRename(title.trim()),
                  },
                  L('重命名', 'Rename')
                )
              )
            : null,
          h(
            'div',
            { className: 'cc-board-list' },
            boards.map((board) => {
              const active = current && current.id === board.id
              return h(
                'div',
                { key: board.id, className: cls('cc-board-row', active && 'is-active') },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-board-open',
                    onClick: () => onOpen(board.id),
                    'aria-label': `${board.title || L('未命名画布', 'Untitled canvas')} · ${L(`${board.nodeCount || 0} 个节点`, `${board.nodeCount || 0} nodes`)}`,
                  },
                  h(
                    'span',
                    { className: 'cc-board-icon' },
                    h(Icon, { name: 'layers', size: 16 })
                  ),
                  h(
                    'span',
                    { className: 'cc-board-info' },
                    h('span', { className: 'cc-board-name' }, board.title || L('未命名画布', 'Untitled canvas')),
                    h(
                      'span',
                      { className: 'cc-board-sub' },
                      L(`${board.nodeCount || 0} 个节点`, `${board.nodeCount || 0} nodes`),
                      board.updatedAt ? ` · ${formatDate(board.updatedAt)}` : ''
                    )
                  ),
                  active ? h('span', { className: 'cc-pill' }, L('当前', 'Current')) : null
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: cls('cc-iconbtn', 'is-danger', confirmId === board.id && 'is-armed'),
                    title: L('删除画布', 'Delete canvas'),
                    onClick: () => {
                      if (confirmId === board.id) {
                        onDelete(board.id)
                        setConfirmId(null)
                      } else {
                        setConfirmId(board.id)
                      }
                    },
                  },
                  confirmId === board.id ? h('span', { className: 'cc-armed-text' }, L('确认', 'Sure')) : h(Icon, { name: 'trash', size: 15 })
                )
              )
            }),
            !boards.length
              ? h('div', { className: 'cc-empty-note' }, h(Icon, { name: 'layers', size: 18 }), h('div', null, h('strong', null, L('还没有画布', 'No canvases yet')), h('p', null, L('新建一个，从一个问题开始。', 'Create one and start with a question.'))))
              : null
          ),
          h(
            'div',
            { className: 'cc-board-foot' },
            h(
              'button',
              { type: 'button', className: 'cc-primary', onClick: onCreate },
              h(Icon, { name: 'plus', size: 16 }),
              L('新建画布', 'New canvas')
            ),
            h('span', { className: 'cc-model-count' }, L('画布数据：$DSH_HOME/canvas-chat', 'Data: $DSH_HOME/canvas-chat'))
          )
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Reader, help, confirm                                               */
    /* ------------------------------------------------------------------ */

    function ReaderModal({ node, modelLabel, onClose, onBranch, onRegenerate, onTextSelect, onContinue, onExport }) {
      const [copyState, setCopyState] = useState('idle')
      const aside = isAsideNode(node)
      const doCopy = () => {
        copyText(aside ? asideTranscript(node) : node.answer || node.prompt).then((ok) => {
          setCopyState(ok ? 'ok' : 'fail')
          setTimeout(() => setCopyState('idle'), 1800)
        })
      }
      return h(
        Modal,
        {
          title: aside ? L('临时对话', 'Side thread') : L('阅读这个分支', 'Read this branch'),
          subtitle: aside
            ? L('这段临时对话已保存到画布，与主分支彼此独立。', 'This side thread is saved on the canvas and stays independent from the main branch.')
            : `${modelLabel || node.model || ''}${node.provider ? ` · ${node.provider}` : ''}`,
          onClose,
          width: 760,
        },
        h(
          'div',
          { className: cls('cc-reader', aside && 'is-aside') },
          h('div', { className: 'cc-reader-label' }, aside ? L('最初的问题', 'First question') : L('你的问题', 'Your prompt')),
          h('div', { className: 'cc-reader-prompt' }, node.prompt),
          h('div', { className: 'cc-reader-label' }, aside ? L('完整临时对话', 'Full side thread') : L('回答', 'Answer')),
          h(
            'div',
            {
              className: 'cc-reader-answer',
              onMouseUp: (event) => {
                if (!aside) onTextSelect(node.id, event.currentTarget)
              },
              onKeyUp: (event) => {
                if (!aside && (event.shiftKey || event.key === 'Shift')) onTextSelect(node.id, event.currentTarget)
              },
            },
            h(Markdown, { text: aside ? asideTranscript(node) : node.answer || L('（还没有回答）', '(no answer yet)') })
          ),
          h(
            'div',
            { className: 'cc-reader-foot' },
            h(
              'button',
              { type: 'button', className: 'cc-secondary', onClick: doCopy },
              h(Icon, { name: copyState === 'ok' ? 'check' : copyState === 'fail' ? 'warning' : 'copy', size: 15 }),
              copyState === 'ok' ? L('已复制', 'Copied') : copyState === 'fail' ? L('复制失败', 'Copy failed') : L('复制', 'Copy')
            ),
            h(
              'button',
              { type: 'button', className: 'cc-secondary', onClick: () => onExport(node.id) },
              h(Icon, { name: 'download', size: 15 }),
              L('导出', 'Export')
            ),
            aside
              ? null
              : h(
                  'button',
                  { type: 'button', className: 'cc-secondary', onClick: () => onRegenerate(node.id) },
                  h(Icon, { name: 'refresh', size: 15 }),
                  L('重新生成', 'Regenerate')
                ),
            aside
              ? h(
                  'button',
                  { type: 'button', className: 'cc-primary', onClick: () => onContinue(node.id) },
                  h(Icon, { name: 'quote', size: 15 }),
                  L('继续追问', 'Continue')
                )
              : h(
                  'button',
                  { type: 'button', className: 'cc-primary', onClick: () => onBranch(node.id) },
                  h(Icon, { name: 'branch', size: 15 }),
                  L('从这里继续', 'Continue here')
                )
          )
        )
      )
    }

    function ExportModal({ node, board, onClose }) {
      const aside = isAsideNode(node)
      const branchNodes = useMemo(() => {
        if (!board || !Array.isArray(board.nodes)) return [node]
        if (aside) return [node]
        const byId = new Map(board.nodes.map((item) => [item.id, item]))
        const chain = []
        const seen = new Set()
        let cursor = node
        while (cursor && !seen.has(cursor.id) && chain.length < 80) {
          seen.add(cursor.id)
          chain.push(cursor)
          cursor = cursor.parentId ? byId.get(cursor.parentId) : null
        }
        return chain.reverse()
      }, [aside, board, node])
      const canBranch = !aside && branchNodes.length > 1
      const [format, setFormat] = useState('docx')
      const [scope, setScope] = useState(canBranch ? 'branch' : 'node')
      const [title, setTitle] = useState(() => {
        if (aside) return String(node.quote || node.prompt || L('临时对话', 'Side thread')).replace(/\s+/g, ' ').slice(0, 60)
        if (board && board.title && board.title !== '未命名画布') return board.title
        return node.prompt || (aside ? '临时对话' : '画布导出')
      })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)

      const sectionCount = aside ? 1 : scope === 'branch' ? branchNodes.length : 1

      useEffect(() => {
        setResult(null)
        setError('')
      }, [format, scope, title])

      const generate = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        setResult(null)
        try {
          const response = await fetch(`${API}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              boardId: board && board.id,
              nodeId: node.id,
              format,
              scope: aside ? 'aside' : scope,
              title: title.trim(),
            }),
          })
          const text = await response.text()
          let payload = null
          try {
            payload = text ? JSON.parse(text) : null
          } catch {
            payload = null
          }
          if (!response.ok) throw new Error((payload && (payload.message || payload.error)) || `HTTP ${response.status}`)
          if (!payload || !payload.file) throw new Error(L('导出没有返回文件。', 'The export returned no file.'))
          setResult(payload.file)
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }

      const download = () => {
        if (!result) return
        const anchor = document.createElement('a')
        anchor.href = result.url || `${API}/export-file?id=${encodeURIComponent(result.id)}`
        anchor.download = result.name || `canvas-export.${format}`
        anchor.rel = 'noopener'
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        setTimeout(() => anchor.remove(), 1000)
      }

      return h(
        Modal,
        {
          title: L('导出文档', 'Export document'),
          subtitle: L('把这张卡片或整条分支整理成 Word / PPT，文件会下载到本地。', 'Turn this card or the whole branch into Word / PowerPoint, then download it.'),
          onClose,
          width: 620,
        },
        h(
          'div',
          { className: 'cc-export' },
          h(
            'div',
            { className: 'cc-export-body' },
            h('div', { className: 'cc-export-label' }, L('格式', 'Format')),
            h(
              'div',
              { className: 'cc-export-formats' },
              h(
                'button',
                {
                  type: 'button',
                  className: cls('cc-export-format', format === 'docx' && 'is-active'),
                  onClick: () => setFormat('docx'),
                },
                h('span', { className: 'cc-export-format-icon' }, h(Icon, { name: 'document', size: 21 })),
                h(
                  'span',
                  { className: 'cc-export-format-copy' },
                  h('strong', null, 'Word'),
                  h('span', null, L('适合阅读、打印和继续编辑的文字稿', 'A readable, printable text document'))
                )
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: cls('cc-export-format', format === 'pptx' && 'is-active'),
                  onClick: () => setFormat('pptx'),
                },
                h('span', { className: 'cc-export-format-icon' }, h(Icon, { name: 'layers', size: 21 })),
                h(
                  'span',
                  { className: 'cc-export-format-copy' },
                  h('strong', null, 'PowerPoint'),
                  h('span', null, L('16:9 演示文稿，适合汇报和分享', 'A 16:9 deck for presenting and sharing'))
                )
              )
            ),
            aside
              ? h(
                  'div',
                  { className: 'cc-export-note' },
                  h(Icon, { name: 'quote', size: 14 }),
                  L('将导出这段已保存的临时对话，包含全部问答。', 'This export contains the whole saved side thread, including all turns.')
                )
              : canBranch
                ? h(
                    React.Fragment,
                    null,
                    h('div', { className: 'cc-export-label' }, L('范围', 'Scope')),
                    h(
                      'div',
                      { className: 'cc-export-scopes' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: cls('cc-export-scope', scope === 'node' && 'is-active'),
                          onClick: () => setScope('node'),
                        },
                        h('strong', null, L('仅这条回答', 'This answer')),
                        h('span', null, L('只导出当前卡片', 'Only the current card'))
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: cls('cc-export-scope', scope === 'branch' && 'is-active'),
                          onClick: () => setScope('branch'),
                        },
                        h('strong', null, L('整条分支', 'Whole branch')),
                        h('span', null, L(`${branchNodes.length} 个节点，按对话顺序整理`, `${branchNodes.length} cards in conversation order`))
                      )
                    )
                  )
                : null,
            h('div', { className: 'cc-export-label' }, L('文档标题', 'Title')),
            h('input', {
              className: 'cc-export-title',
              value: title,
              maxLength: 120,
              placeholder: L('给这份文档起个标题', 'Give this document a title'),
              onChange: (event) => setTitle(event.target.value),
            }),
            result
              ? h(
                  'div',
                  { className: 'cc-export-result' },
                  h('span', { className: 'cc-export-result-icon' }, h(Icon, { name: 'check', size: 16 })),
                  h(
                    'div',
                    { className: 'cc-export-result-copy' },
                    h('strong', null, result.name),
                    h('span', null, `${result.format === 'pptx' ? 'PowerPoint' : 'Word'} · ${describeSize(result.size)} · ${L(`${result.sections} 个部分`, `${result.sections} sections`)}`)
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'cc-primary is-small', onClick: download },
                    h(Icon, { name: 'download', size: 14 }),
                    L('下载', 'Download')
                  )
                )
              : null,
            error ? h('div', { className: 'cc-export-error' }, h(Icon, { name: 'warning', size: 14 }), error) : null
          ),
          h(
            'div',
            { className: 'cc-export-foot' },
            h(
              'span',
              { className: 'cc-export-summary' },
              h(Icon, { name: format === 'docx' ? 'document' : 'layers', size: 13 }),
              L(`将导出 ${sectionCount} 个部分`, `${sectionCount} section${sectionCount === 1 ? '' : 's'}`)
            ),
            h(
              'button',
              { type: 'button', className: 'cc-secondary', onClick: onClose },
              L('取消', 'Cancel')
            ),
            h(
              'button',
              { type: 'button', className: 'cc-primary', onClick: generate, disabled: busy || !title.trim() },
              busy ? h(ThinkingDots) : h(Icon, { name: 'download', size: 15 }),
              busy ? L('正在生成…', 'Generating…') : L('生成文件', 'Generate')
            )
          )
        )
      )
    }

    function AsidePanel({ aside, source, contextCount, modelLabel, onClose, onDraft, onSend, onStop, onLocate, onSave, saved, canSave }) {
      const inputRef = useRef(null)
      useEffect(() => {
        if (inputRef.current) inputRef.current.focus()
      }, [aside && aside.id])

      const messages = (aside && aside.messages) || []
      const streaming = !!(aside && aside.streaming)
      const canSend = !!(aside && aside.draft.trim()) && !streaming
      return h(
        'aside',
        { className: 'cc-aside-panel', onPointerDown: (event) => event.stopPropagation() },
        h(
          'div',
          { className: 'cc-aside-head' },
          h(
            'div',
            { className: 'cc-aside-title' },
            h('span', { className: 'cc-aside-kicker' }, h(Icon, { name: 'quote', size: 13 }), L('临时追问', 'SIDE THREAD')),
            h(
              'span',
              { className: 'cc-aside-sub' },
              saved
                ? L('已保存 · 继续追问会更新原卡片', 'Saved · follow-ups update this card')
                : L('不影响主对话', 'Main thread untouched')
            )
          ),
          h(
            'div',
            { className: 'cc-aside-actions' },
            h(
              'button',
              {
                type: 'button',
                className: cls('cc-aside-save', saved && 'is-saved'),
                disabled: !canSave,
                title: saved
                  ? L('把最新一轮临时对话更新到画布', 'Update the saved side thread on the canvas')
                  : L('把这段临时对话保存到画布', 'Save this side thread to the canvas'),
                onClick: onSave,
              },
              h(Icon, { name: saved ? 'check' : 'plus', size: 13 }),
              saved ? L('更新画布', 'Update') : L('保存到画布', 'Save to canvas')
            ),
            h(
              'button',
              { type: 'button', className: 'cc-iconbtn', title: L('关闭临时追问', 'Close side thread'), onClick: onClose },
              h(Icon, { name: 'close', size: 15 })
            )
          )
        ),
        h(
          'div',
          { className: 'cc-aside-quote' },
          h('div', { className: 'cc-aside-quote-label' }, h(Icon, { name: 'quote', size: 11 }), L('选中内容', 'Selected passage')),
          h('blockquote', null, aside.quote),
          h(
            'div',
            { className: 'cc-aside-source' },
            h(
              'span',
              { title: source && source.prompt ? source.prompt : '' },
              source
                ? L('来自：', 'From: ') + ((source.prompt || source.answer) || '').replace(/\s+/g, ' ').slice(0, 60)
                : L('已保存的临时对话（原节点已移除）', 'Saved side thread (source removed)')
            ),
            source
              ? h(
                  'button',
                  { type: 'button', className: 'cc-aside-locate', onClick: onLocate },
                  h(Icon, { name: 'focus', size: 11 }),
                  L('定位原回答', 'Locate')
                )
              : null
          )
        ),
        h(
          'div',
          { className: 'cc-aside-body' },
          contextCount ? h('div', { className: 'cc-aside-context' }, h(Icon, { name: 'branch', size: 12 }), L(`已继承主对话 ${contextCount} 轮上下文`, `Main context: ${contextCount} turns`)) : null,
          messages.length === 0
            ? h(
                'div',
                { className: 'cc-aside-empty' },
                h(Icon, { name: 'quote', size: 18 }),
                h('strong', null, L('只问这一段', 'Ask about this')),
                h('p', null, L('问题会带着原回答的完整语境发送，但不会写入画布，也不会改变主分支。回答后可以点「保存到画布」，把它作为一张独立的临时对话卡片留下。', 'The full source answer is included as context, but this thread stays out of the canvas and never changes the main branch. After it answers, use Save to canvas to keep it as an independent side-thread card.'))
              )
            : messages.map((message, index) => {
                const last = index === messages.length - 1
                const pending = streaming && last && message.role === 'assistant' && !message.content
                return h(
                  'div',
                  { key: message.id || index, className: cls('cc-aside-msg', message.role === 'user' ? 'is-user' : 'is-assistant') },
                  h('div', { className: 'cc-aside-msg-label' }, message.role === 'user' ? L('你', 'You') : L('临时回答', 'Side answer')),
                  message.role === 'assistant'
                    ? pending
                      ? h('div', { className: 'cc-aside-waiting' }, h(ThinkingDots), h('span', null, L('正在看这段内容…', 'Reading this passage…')))
                      : h(Markdown, { text: message.content })
                    : h('div', { className: 'cc-aside-user-text' }, message.content)
                )
              }),
          aside.error ? h('div', { className: 'cc-aside-error' }, h(Icon, { name: 'warning', size: 13 }), aside.error) : null
        ),
        h(
          'div',
          { className: 'cc-aside-composer' },
          h('textarea', {
            ref: inputRef,
            value: aside.draft,
            placeholder: L('就选中的内容提问，Enter 发送…', 'Ask about the selected text. Enter to send…'),
            onChange: (event) => onDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (canSend) onSend()
              }
            },
          }),
          h(
            'div',
            { className: 'cc-aside-bar' },
            h('span', { className: 'cc-aside-model', title: modelLabel || '' }, h(Icon, { name: 'spark', size: 11 }), modelLabel || L('当前模型', 'Current model')),
            h(
              'button',
              {
                type: 'button',
                className: cls('cc-aside-send', streaming && 'is-stop'),
                disabled: streaming ? false : !canSend,
                onClick: streaming ? onStop : onSend,
                title: streaming ? L('停止临时追问', 'Stop side question') : L('发送临时追问', 'Send side question'),
              },
              streaming ? h(Icon, { name: 'stop', size: 13 }) : h(Icon, { name: 'send', size: 13 }),
              streaming ? L('停止', 'Stop') : L('发送', 'Send')
            )
          )
        )
      )
    }

    function HelpModal({ onClose }) {
      const rows = [
        [L('拖动空白处', 'Drag empty space'), L('平移画布', 'Pan the canvas')],
        [L('滚轮', 'Mouse wheel'), L('以光标为中心缩放', 'Zoom around the pointer')],
        [L('拖动节点顶部', 'Drag a node header'), L('移动这个节点', 'Move that node')],
        [L('移动节点后', 'After moving a node'), L('连线会从两张卡片相对最近的上、下或侧边重新引出', 'The edge rejoins from the nearest top, bottom or side of both cards')],
        [L('双击画布', 'Double-click canvas'), L('在点击处新建一个话题', 'Start a topic there')],
        [L('双击节点', 'Double-click a node'), L('放大阅读完整回答', 'Read the full answer')],
        [L('选中回答中的文字', 'Select text in an answer'), L('针对这段内容单独追问；默认不写入画布', 'Ask about that passage in a side thread; nothing is written by default')],
        [L('「保存到画布」', 'Save to canvas'), L('把临时对话变成暖色虚线卡片，之后可点「继续追问」接着问并更新', 'Turn a side thread into a warm dashed card; use Continue later to keep asking and update it')],
        [L('上传 Word / PPT', 'Upload Word / PowerPoint'), L('提取正文、表格与幻灯片备注，作为当前问题的上下文', 'Extract text, tables and speaker notes as context for the current prompt')],
        [L('「导出」', 'Export'), L('把一条回答或整条分支导出为 Word 或 16:9 PPT', 'Export one answer or the whole branch as Word or a 16:9 deck')],
        [L('Ctrl / Cmd + F', 'Ctrl / Cmd + F'), L('搜索画布中的问题与回答', 'Search prompts and answers on the canvas')],
        [L('聚焦按钮', 'Focus button'), L('只显示当前分支的路径与下游，淡化其他节点', 'Show this branch path and descendants, dim everything else')],
        [L('切换画布', 'Switch canvas'), L('未完成的生成会在后台继续，完成后自动保存', 'Unfinished generations keep running in the background and save when done')],
        [L('Enter', 'Enter'), L('在输入框中发送；Shift+Enter 换行', 'Send in the composer; Shift+Enter for a newline')],
        [L('Esc', 'Esc'), L('关闭输入框、搜索或弹窗', 'Close the composer, search, or a dialog')],
      ]
      return h(
        Modal,
        {
          title: L('画布分叉聊天怎么用', 'How Branching Canvas works'),
          subtitle: L('对话不必是一条线。每次回答都可以成为一个新分支。', 'A conversation does not have to be a line. Every answer can grow a new branch.'),
          onClose,
          width: 620,
        },
        h(
          'div',
          { className: 'cc-help' },
          h(
            'div',
            { className: 'cc-help-concept' },
            h('div', { className: 'cc-help-orb' }, h(Icon, { name: 'branch', size: 22 })),
            h(
              'div',
              null,
              h('strong', null, L('节点 = 一次问答', 'A node = one exchange')),
              h('p', null, L('每张卡片保存你的问题和模型的回答。卡片之间的线表示上下文从哪里来。', 'Each card keeps your prompt and the answer. Lines show where its context comes from.'))
            )
          ),
          h(
            'div',
            { className: 'cc-help-concept' },
            h('div', { className: 'cc-help-orb' }, h(Icon, { name: 'refresh', size: 22 })),
            h(
              'div',
              null,
              h('strong', null, L('复用 DSH 的模型配置', 'Reuses DSH model settings')),
              h('p', null, L('画布调用的是 DSH 自己的 llm 服务：你在设置里配置的提供方、密钥和默认模型会直接生效。', 'The canvas calls DSH\'s own llm service, so the providers, keys and default model configured in Settings apply directly.'))
            )
          ),
          h(
            'div',
            { className: 'cc-help-concept' },
            h('div', { className: 'cc-help-orb' }, h(Icon, { name: 'document', size: 22 })),
            h(
              'div',
              null,
              h('strong', null, L('文档进，文档出', 'Documents in, documents out')),
              h('p', null, L('可以上传 .docx / .pptx 让模型读其中的文字；也可以把回答导出成新的 Word 或 PPT。第一版不修改原文件的版式。', 'Upload .docx / .pptx for the model to read; export an answer as a new Word document or deck. The first version does not edit an original file in place.'))
            )
          ),
          h(
            'div',
            { className: 'cc-shortcuts' },
            rows.map((row, index) =>
              h(
                'div',
                { key: index, className: 'cc-shortcut-row' },
                h('kbd', null, row[0]),
                h('span', null, row[1])
              )
            )
          )
        )
      )
    }

    function ConfirmModal({ title, message, confirmLabel, danger, onConfirm, onClose }) {
      return h(
        Modal,
        { title, onClose, width: 460 },
        h(
          'div',
          { className: 'cc-confirm' },
          h('p', null, message),
          h(
            'div',
            { className: 'cc-confirm-actions' },
            h('button', { type: 'button', className: 'cc-secondary', onClick: onClose }, L('取消', 'Cancel')),
            h(
              'button',
              { type: 'button', className: cls('cc-primary', danger && 'is-danger'), onClick: onConfirm },
              confirmLabel || L('确认', 'Confirm')
            )
          )
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Minimap                                                             */
    /* ------------------------------------------------------------------ */

    function Minimap({ nodes, viewport, stageSize, onNavigate }) {
      const W = 190
      const H = 126
      const pad = 12
      const vx = (0 - viewport.x) / viewport.scale
      const vy = (0 - viewport.y) / viewport.scale
      const vw = (stageSize.w || 1200) / viewport.scale
      const vh = (stageSize.h || 800) / viewport.scale
      const bounds = useMemo(() => {
        if (!nodes.length) return null
        let minX = vx
        let minY = vy
        let maxX = vx + vw
        let maxY = vy + vh
        nodes.forEach((node) => {
          minX = Math.min(minX, node.x)
          minY = Math.min(minY, node.y)
          maxX = Math.max(maxX, node.x + NODE_W)
          maxY = Math.max(maxY, node.y + NODE_H)
        })
        return { minX, minY, maxX, maxY }
      }, [nodes, vx, vy, vw, vh])
      if (!bounds) return null
      const bw = Math.max(1, bounds.maxX - bounds.minX)
      const bh = Math.max(1, bounds.maxY - bounds.minY)
      const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh) * 0.92
      const ox = (W - bw * scale) / 2 - bounds.minX * scale
      const oy = (H - bh * scale) / 2 - bounds.minY * scale
      const onClick = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const px = ((event.clientX - rect.left) / rect.width) * W
        const py = ((event.clientY - rect.top) / rect.height) * H
        onNavigate({ x: (px - ox) / scale, y: (py - oy) / scale })
      }
      return h(
        'div',
        { className: 'cc-minimap', title: L('点击跳转', 'Click to jump') },
        h(
          'svg',
          { viewBox: `0 0 ${W} ${H}`, width: W, height: H, onClick },
          h('rect', { x: 0, y: 0, width: W, height: H, rx: 12, className: 'cc-minimap-bg' }),
          nodes.map((node) =>
            h('rect', {
              key: node.id,
              x: node.x * scale + ox,
              y: node.y * scale + oy,
              width: Math.max(2, NODE_W * scale),
              height: Math.max(2, NODE_H * scale),
              rx: 2,
              className: cls('cc-minimap-node', isAsideNode(node) && 'is-aside', node.streaming && 'is-streaming'),
            })
          ),
          h('rect', {
            x: vx * scale + ox,
            y: vy * scale + oy,
            width: Math.max(4, vw * scale),
            height: Math.max(4, vh * scale),
            rx: 2,
            className: 'cc-minimap-view',
          })
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Composer dock                                                       */
    /* ------------------------------------------------------------------ */

    function ComposerDock({
      composer,
      parent,
      contextCount,
      modelLabel,
      canSend,
      uploading,
      onDraft,
      onSend,
      onAttach,
      onRemoveAttachment,
      onClose,
      onPickModel,
    }) {
      const areaRef = useRef(null)
      useEffect(() => {
        if (areaRef.current) areaRef.current.focus()
      }, [composer.key])
      useEffect(() => {
        const area = areaRef.current
        if (!area) return
        area.style.height = 'auto'
        area.style.height = `${Math.min(180, area.scrollHeight)}px`
      }, [composer.draft])
      const attachments = Array.isArray(composer.attachments) ? composer.attachments : []
      const send = () => {
        if (uploading) return
        if (!composer.draft.trim() && !attachments.length) return
        onSend(composer.draft, attachments)
      }
      return h(
        'div',
        { className: 'cc-dock' },
        h(
          'div',
          { className: 'cc-composer' },
          composer.parentId && parent
            ? h(
                'div',
                { className: 'cc-composer-context' },
                h(Icon, { name: 'branch', size: 13 }),
                h('span', { className: 'cc-composer-context-label' }, L('继承自', 'From')),
                h('span', { className: 'cc-composer-context-text' }, parent.prompt || parent.answer || ''),
                h('span', { className: 'cc-composer-context-count' }, L(`${contextCount} 轮上下文`, `${contextCount} turns of context`))
              )
            : h(
                'div',
                { className: 'cc-composer-context' },
                h(Icon, { name: 'spark', size: 13 }),
                h('span', { className: 'cc-composer-context-label' }, L('新的起点', 'New root')),
                h('span', { className: 'cc-composer-context-count' }, L('不继承任何上下文', 'No inherited context'))
              ),
          h(AttachmentTray, {
            items: attachments,
            onRemove: onRemoveAttachment,
            uploading,
          }),
          h('textarea', {
            ref: areaRef,
            className: 'cc-composer-input',
            value: composer.draft,
            rows: 1,
            placeholder: composer.parentId
              ? L('在这个分支上继续问，或者换一个方向…', 'Continue this branch, or take it somewhere else…')
              : L('从一个问题开始。回车发送，Shift+回车换行。', 'Start with a question. Enter to send, Shift+Enter for a newline.'),
            onChange: (event) => onDraft(event.target.value),
            onPaste: (event) => {
              const files = Array.from((event.clipboardData && event.clipboardData.files) || [])
              if (files.length) {
                event.preventDefault()
                onAttach(files)
              }
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
              if (event.key === 'Escape') onClose()
            },
          }),
          h(
            'div',
            { className: 'cc-composer-bar' },
            h(AttachmentButton, { onFiles: onAttach, disabled: uploading }),
            h(
              'button',
              { type: 'button', className: 'cc-chip is-subtle', onClick: onPickModel, 'aria-label': L('选择模型', 'Choose model') },
              h(Icon, { name: 'spark', size: 14 }),
              h('span', null, modelLabel || L('选择模型', 'Choose model')),
              h(Icon, { name: 'chevron', size: 13 })
            ),
            h('span', { className: 'cc-spacer' }),
            h(
              'button',
              { type: 'button', className: 'cc-iconbtn', title: L('关闭', 'Close'), onClick: onClose },
              h(Icon, { name: 'close', size: 15 })
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-send',
                disabled: !canSend || uploading || (!composer.draft.trim() && !attachments.length),
                onClick: send,
              },
              h(Icon, { name: 'send', size: 16 }),
              L('发送', 'Send')
            )
          )
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Hero (empty canvas)                                                 */
    /* ------------------------------------------------------------------ */

    function Hero({ draft, attachments, uploading, onDraft, onSend, onAttach, onRemoveAttachment, canSend, modelLabel, onPickModel }) {
      const areaRef = useRef(null)
      useEffect(() => {
        if (areaRef.current) areaRef.current.focus()
      }, [])
      const list = Array.isArray(attachments) ? attachments : []
      const go = () => {
        if (uploading) return
        if (!String(draft || '').trim() && !list.length) return
        onSend(draft, list)
      }
      const suggestions = LANG === 'zh'
        ? [
            '帮我把一个模糊的想法拆成几个可探索的方向',
            '比较两种方案，指出各自的代价',
            '我想写一个短篇故事，先给我三个不同的开头',
            '从第一性原理解释一个我可能理解错了的概念',
          ]
        : [
            'Split a vague idea into a few directions worth exploring',
            'Compare two approaches and name the cost of each',
            'Give me three different openings for a short story',
            'Explain a concept I may have misunderstood, from first principles',
          ]
      return h(
        'div',
        { className: 'cc-hero' },
        h(
          'div',
          { className: 'cc-hero-orb' },
          h('div', { className: 'cc-hero-orb-inner' }, h(BrandMark, { size: 38 }))
        ),
        h('h1', { className: 'cc-hero-title' }, L('让对话长成一棵树', 'Let the conversation grow into a tree')),
        h('p', { className: 'cc-hero-sub' }, L('每次回答都可以成为一个新分支。拖动、缩放、发散——不必再把思路塞回一条直线。', 'Every answer can become a new branch. Drag, zoom, diverge — no need to force ideas back into a straight line.')),
        h(
          'div',
          { className: 'cc-hero-composer' },
          h(AttachmentTray, { items: list, onRemove: onRemoveAttachment, uploading }),
          h('textarea', {
            ref: areaRef,
            rows: 2,
            value: draft,
            placeholder: L('从一个问题开始…', 'Start with a question…'),
            onChange: (event) => onDraft(event.target.value),
            onPaste: (event) => {
              const files = Array.from((event.clipboardData && event.clipboardData.files) || [])
              if (files.length) {
                event.preventDefault()
                onAttach(files)
              }
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                go()
              }
            },
          }),
          h(
            'div',
            { className: 'cc-hero-composer-bar' },
            h(AttachmentButton, { onFiles: onAttach, disabled: uploading }),
            h(
              'button',
              { type: 'button', className: 'cc-chip is-subtle', onClick: onPickModel, 'aria-label': L('选择模型', 'Choose model') },
              h(Icon, { name: 'spark', size: 14 }),
              h('span', null, modelLabel || L('选择模型', 'Choose model')),
              h(Icon, { name: 'chevron', size: 13 })
            ),
            h('span', { className: 'cc-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-send',
                disabled: !canSend || uploading || (!String(draft || '').trim() && !list.length),
                onClick: go,
              },
              h(Icon, { name: 'send', size: 16 }),
              L('开始', 'Start')
            )
          )
        ),
        h(
          'div',
          { className: 'cc-hero-chips' },
          suggestions.map((text) =>
            h(
              'button',
              { key: text, type: 'button', className: 'cc-suggestion', onClick: () => onSend(text), 'aria-label': text },
              h(Icon, { name: 'arrow', size: 13 }),
              h('span', null, text)
            )
          )
        ),
        h(
          'div',
          { className: 'cc-hero-foot' },
          h(Icon, { name: 'spark', size: 13 }),
          L('模型与密钥来自 DSH 当前配置，不会复制到画布里。', 'Models and keys come from your live DSH configuration; nothing is copied into the canvas.')
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Edges                                                               */
    /* ------------------------------------------------------------------ */

    function edgeGeometry(parent, child) {
      const a = {
        left: parent.x,
        top: parent.y,
        right: parent.x + NODE_W,
        bottom: parent.y + NODE_H,
        cx: parent.x + NODE_W / 2,
        cy: parent.y + NODE_H / 2,
      }
      const b = {
        left: child.x,
        top: child.y,
        right: child.x + NODE_W,
        bottom: child.y + NODE_H,
        cx: child.x + NODE_W / 2,
        cy: child.y + NODE_H / 2,
      }
      const gapX = Math.max(b.left - a.right, a.left - b.right, 0)
      const gapY = Math.max(b.top - a.bottom, a.top - b.bottom, 0)
      const overlap = gapX === 0 && gapY === 0
      const horizontal = overlap
        ? Math.abs(b.cx - a.cx) >= Math.abs(b.cy - a.cy)
        : gapX >= gapY
      if (horizontal) {
        const forward = b.cx >= a.cx
        const x1 = forward ? a.right : a.left
        const x2 = forward ? b.left : b.right
        const y1 = Math.max(a.top + 24, Math.min(a.bottom - 24, b.cy))
        const y2 = Math.max(b.top + 24, Math.min(b.bottom - 24, a.cy))
        const dir = forward ? 1 : -1
        const bend = Math.max(30, Math.min(170, Math.abs(x2 - x1) * 0.42 + 18))
        return {
          d: `M ${x1} ${y1} C ${x1 + dir * bend} ${y1}, ${x2 - dir * bend} ${y2}, ${x2} ${y2}`,
          x1,
          y1,
          x2,
          y2,
        }
      }
      const forward = b.cy >= a.cy
      const y1 = forward ? a.bottom : a.top
      const y2 = forward ? b.top : b.bottom
      const x1 = Math.max(a.left + 24, Math.min(a.right - 24, b.cx))
      const x2 = Math.max(b.left + 24, Math.min(b.right - 24, a.cx))
      const dir = forward ? 1 : -1
      const bend = Math.max(30, Math.min(170, Math.abs(y2 - y1) * 0.42 + 18))
      return {
        d: `M ${x1} ${y1} C ${x1} ${y1 + dir * bend}, ${x2} ${y2 - dir * bend}, ${x2} ${y2}`,
        x1,
        y1,
        x2,
        y2,
      }
    }

    function Edges({ nodes, activeEdges, focusSet }) {
      const map = useMemo(() => nodeMapOf(nodes), [nodes])
      const mainEdges = nodes
        .filter((node) => node.parentId && map.has(node.parentId))
        .map((node) => {
          const parent = map.get(node.parentId)
          const geometry = edgeGeometry(parent, node)
          const active = activeEdges.has(node.id)
          const dimmed = focusSet && (!focusSet.has(node.id) || !focusSet.has(parent.id))
          return h(
            'g',
            { key: node.id, className: cls('cc-edge', active && 'is-active', node.streaming && 'is-streaming', dimmed && 'is-dimmed') },
            h('path', { d: geometry.d, className: 'cc-edge-shadow' }),
            h('path', { d: geometry.d, className: 'cc-edge-line' }),
            h('circle', { cx: geometry.x2, cy: geometry.y2, r: 3.2, className: 'cc-edge-dot' })
          )
        })
      const asideEdges = nodes
        .filter((node) => isAsideNode(node) && node.anchorId && map.has(node.anchorId))
        .map((node) => {
          const anchor = map.get(node.anchorId)
          const geometry = edgeGeometry(anchor, node)
          const dimmed = focusSet && (!focusSet.has(node.id) || !focusSet.has(anchor.id))
          return h(
            'g',
            { key: `aside-${node.id}`, className: cls('cc-edge is-aside', dimmed && 'is-dimmed') },
            h('path', { d: geometry.d, className: 'cc-edge-shadow' }),
            h('path', { d: geometry.d, className: 'cc-edge-line' }),
            h('circle', { cx: geometry.x1, cy: geometry.y1, r: 2.6, className: 'cc-edge-origin' }),
            h('circle', { cx: geometry.x2, cy: geometry.y2, r: 3, className: 'cc-edge-dot' })
          )
        })
      return h(
        'svg',
        { className: 'cc-edges', width: 1, height: 1, 'aria-hidden': 'true' },
        [...mainEdges, ...asideEdges]
      )
    }

    /* ------------------------------------------------------------------ */
    /* Main page                                                           */
    /* ------------------------------------------------------------------ */

    function mergeBoardMeta(boards, saved) {
      if (!saved) return boards
      const nodes = Array.isArray(saved.nodes) ? saved.nodes : []
      const meta = {
        id: saved.id,
        title: saved.title,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        nodeCount: nodes.length,
        preview: (nodes.find((node) => node.prompt) || {}).prompt || '',
      }
      return [meta, ...boards.filter((board) => board.id !== saved.id)].sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt))
      )
    }

    function blankBoard() {
      return {
        id: uid('b'),
        title: L('未命名画布', 'Untitled canvas'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        viewport: { x: 0, y: 0, scale: 0.9 },
        nodes: [],
      }
    }

    function CanvasChatPage() {
      const stageRef = useRef(null)
      const boardRef = useRef(null)
      const viewportRef = useRef({ x: 0, y: 0, scale: 0.9 })
      const stageSizeRef = useRef({ w: 1200, h: 800 })
      const modelRef = useRef(null)
      const saveTimer = useRef(null)
      const streamsRef = useRef(new Map())
      const streamBoardRef = useRef(new Map())
      const toastTimer = useRef(null)
      const composerWorldRef = useRef(null)
      const dragRef = useRef(null)
      const panRef = useRef(null)
      const mountedRef = useRef(true)
      const pendingFitRef = useRef(false)
      const boardCacheRef = useRef(new Map())
      const asideRef = useRef(null)
      const asideStreamRef = useRef(null)

      const [boot, setBoot] = useState(null)
      const [bootError, setBootError] = useState('')
      const [reloadKey, setReloadKey] = useState(0)
      const [board, setBoard] = useState(null)
      const [loadingBoard, setLoadingBoard] = useState(true)
      const [selectedId, setSelectedId] = useState(null)
      const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 0.9 })
      const [stageSize, setStageSize] = useState({ w: 1200, h: 800 })
      const [model, setModel] = useState(() => readLS(STORE_MODEL, null))
      const [saveState, setSaveState] = useState('saved')
      const [composer, setComposer] = useState(null)
      const [heroDraft, setHeroDraft] = useState('')
      const [heroAttachments, setHeroAttachments] = useState([])
      const [uploading, setUploading] = useState(false)
      const [modal, setModal] = useState(null)
      const [toast, setToast] = useState(null)
      const [panning, setPanning] = useState(false)
      const [draggingId, setDraggingId] = useState(null)
      const [selectionMenu, setSelectionMenu] = useState(null)
      const [aside, setAside] = useState(null)
      const [finderOpen, setFinderOpen] = useState(false)
      const [finderQuery, setFinderQuery] = useState('')
      const [finderIndex, setFinderIndex] = useState(0)
      const [focusId, setFocusId] = useState(null)
      const [activeStreams, setActiveStreams] = useState(0)

      useEffect(() => {
        boardRef.current = board
        if (board) boardCacheRef.current.set(board.id, board)
      }, [board])
      useEffect(() => {
        asideRef.current = aside
      }, [aside])
      const previousBoardIdRef = useRef(null)
      useEffect(() => {
        const id = board && board.id
        if (!id) return
        if (previousBoardIdRef.current && previousBoardIdRef.current !== id) {
          if (asideStreamRef.current) {
            try {
              asideStreamRef.current.abort()
            } catch {
              /* already aborted */
            }
            asideStreamRef.current = null
          }
          setAside(null)
          setSelectionMenu(null)
          setFocusId(null)
          setFinderOpen(false)
          setFinderQuery('')
          setSelectedId(null)
        }
        previousBoardIdRef.current = id
      }, [board && board.id])
      useEffect(() => {
        viewportRef.current = viewport
      }, [viewport])
      useEffect(() => {
        stageSizeRef.current = stageSize
      }, [stageSize])
      useEffect(() => {
        modelRef.current = model
      }, [model])
      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      const notify = useCallback((message, kind) => {
        if (!mountedRef.current) return
        setToast({ message, kind: kind || 'info', id: Date.now() })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => {
          if (mountedRef.current) setToast(null)
        }, 2800)
      }, [])

      const attachFiles = useCallback(
        async (files, target) => {
          const incoming = Array.from(files || []).filter(Boolean)
          if (!incoming.length) return
          const existing = target === 'hero' ? heroAttachments : (composer && composer.attachments) || []
          let room = Math.max(0, MAX_ATTACHMENTS - existing.length)
          if (!room) {
            notify(L(`每条消息最多 ${MAX_ATTACHMENTS} 个附件。`, `Up to ${MAX_ATTACHMENTS} attachments per message.`), 'warn')
            return
          }
          setUploading(true)
          const accepted = []
          try {
            for (const file of incoming) {
              if (room <= 0) {
                notify(L(`每条消息最多 ${MAX_ATTACHMENTS} 个附件。`, `Up to ${MAX_ATTACHMENTS} attachments per message.`), 'warn')
                break
              }
              try {
                const attachment = await uploadAttachment(file)
                if (attachment) {
                  accepted.push(attachment)
                  room -= 1
                }
              } catch (error) {
                notify(errorText(error), 'error')
              }
            }
          } finally {
            if (mountedRef.current) setUploading(false)
          }
          if (!accepted.length || !mountedRef.current) return
          if (target === 'hero') {
            setHeroAttachments((prev) => prev.concat(accepted).slice(0, MAX_ATTACHMENTS))
          } else {
            setComposer((prev) =>
              prev
                ? { ...prev, attachments: (prev.attachments || []).concat(accepted).slice(0, MAX_ATTACHMENTS) }
                : prev
            )
          }
        },
        [composer, heroAttachments, notify]
      )

      const removeAttachment = useCallback((target, id) => {
        if (target === 'hero') {
          setHeroAttachments((prev) => prev.filter((item) => item.id !== id))
        } else {
          setComposer((prev) =>
            prev ? { ...prev, attachments: (prev.attachments || []).filter((item) => item.id !== id) } : prev
          )
        }
      }, [])

      const persist = useCallback(
        (immediate) => {
          const current = boardRef.current
          if (!current) return
          if (current.nodes && current.nodes.some((node) => node.streaming)) return
          if (saveTimer.current) clearTimeout(saveTimer.current)
          setSaveState('saving')
          const run = async () => {
            try {
              const payload = { ...current, viewport: viewportRef.current }
              const data = await api('/board', { method: 'POST', body: { board: payload } })
              if (!mountedRef.current) return
              setSaveState('saved')
              if (data && data.board) {
                setBoot((prev) => (prev ? { ...prev, boards: mergeBoardMeta(prev.boards, data.board) } : prev))
              }
            } catch (error) {
              if (!mountedRef.current) return
              setSaveState('error')
              notify(errorText(error), 'error')
            }
          }
          if (immediate) run()
          else saveTimer.current = setTimeout(run, 850)
        },
        [notify]
      )

      const commit = useCallback(
        (updater, options) => {
          setBoard((prev) => {
            if (!prev) return prev
            const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
            boardRef.current = next
            boardCacheRef.current.set(next.id, next)
            return next
          })
          if (options && options.save) {
            const immediate = !!options.immediate
            setTimeout(() => persist(immediate), 0)
          }
        },
        [persist]
      )

      const updateNode = useCallback(
        (id, patch) => {
          commit((prev) => ({
            ...prev,
            nodes: prev.nodes.map((node) =>
              node.id === id ? { ...node, ...(typeof patch === 'function' ? patch(node) : patch) } : node
            ),
          }))
        },
        [commit]
      )

      const updateNodeScoped = useCallback(
        (boardId, id, patch) => {
          const targetId = boardId || (boardRef.current && boardRef.current.id)
          if (!targetId) return
          if (boardRef.current && boardRef.current.id === targetId) {
            updateNode(id, patch)
            return
          }
          const cached = boardCacheRef.current.get(targetId)
          if (!cached) return
          const next = {
            ...cached,
            nodes: cached.nodes.map((node) =>
              node.id === id ? { ...node, ...(typeof patch === 'function' ? patch(node) : patch) } : node
            ),
          }
          boardCacheRef.current.set(targetId, next)
        },
        [updateNode]
      )

      const saveBoardById = useCallback(
        async (id) => {
          const target = boardCacheRef.current.get(id)
          if (!target || (target.nodes || []).some((node) => node.streaming)) return
          try {
            const data = await api('/board', { method: 'POST', body: { board: target } })
            if (!mountedRef.current) return
            const active = boardRef.current && boardRef.current.id === id
            if (active) setSaveState('saved')
            if (data && data.board) {
              setBoot((prev) => (prev ? { ...prev, boards: mergeBoardMeta(prev.boards, data.board) } : prev))
            }
          } catch (error) {
            const active = boardRef.current && boardRef.current.id === id
            if (active) setSaveState('error')
            if (active) notify(errorText(error), 'error')
          }
        },
        [notify]
      )

      const loadBoard = useCallback(
        async (id) => {
          setLoadingBoard(true)
          setSelectedId(null)
          setComposer(null)
          const active = boardRef.current
          if (active) {
            const snapshot = { ...active, viewport: viewportRef.current }
            boardRef.current = snapshot
            boardCacheRef.current.set(active.id, snapshot)
            if (active.id !== id) void saveBoardById(active.id)
          }
          const cached = boardCacheRef.current.get(id)
          if (cached) {
            boardRef.current = cached
            setBoard(cached)
            const cachedViewport = cached.viewport && cached.viewport.scale ? cached.viewport : null
            if (cachedViewport) {
              viewportRef.current = cachedViewport
              setViewport(cachedViewport)
            } else {
              pendingFitRef.current = true
            }
            writeLS(STORE_BOARD, cached.id)
            setLoadingBoard(false)
            return
          }
          try {
            const data = await api(`/board?id=${encodeURIComponent(id)}`)
            if (!mountedRef.current) return
            const next = data.board
            boardRef.current = next
            boardCacheRef.current.set(next.id, next)
            setBoard(next)
            const vp = next.viewport && next.viewport.scale ? next.viewport : null
            if (vp) {
              viewportRef.current = vp
              setViewport(vp)
            } else {
              pendingFitRef.current = true
            }
            writeLS(STORE_BOARD, next.id)
          } catch (error) {
            notify(errorText(error), 'error')
          } finally {
            if (mountedRef.current) setLoadingBoard(false)
          }
        },
        [notify, saveBoardById]
      )

      useEffect(() => {
        let cancelled = false
        setBootError('')
        setLoadingBoard(true)
        api('/bootstrap')
          .then((data) => {
            if (cancelled || !mountedRef.current) return
            setBoot(data)
            const saved = readLS(STORE_MODEL, null)
            const fallback = (() => {
              const selection = data.defaultSelection
              if (selection && selection.provider && selection.model) {
                return { provider: String(selection.provider), model: String(selection.model) }
              }
              for (const provider of data.providers || []) {
                if (provider.models && provider.models.length) {
                  return { provider: provider.id, model: provider.models[0].id }
                }
              }
              return null
            })()
            const nextModel = saved && saved.provider && saved.model ? saved : fallback
            modelRef.current = nextModel
            setModel(nextModel)
            const last = readLS(STORE_BOARD, null)
            const target = (data.boards || []).find((item) => item.id === last) || (data.boards || [])[0]
            if (target) {
              void loadBoard(target.id)
            } else {
              const fresh = blankBoard()
              boardRef.current = fresh
              setBoard(fresh)
              setLoadingBoard(false)
              const vp = { x: 0, y: 0, scale: 0.9 }
              viewportRef.current = vp
              setViewport(vp)
              void api('/board', { method: 'POST', body: { board: fresh } })
                .then((saved) => {
                  if (cancelled || !mountedRef.current || !saved || !saved.board) return
                  setBoot((prev) => (prev ? { ...prev, boards: mergeBoardMeta(prev.boards, saved.board) } : prev))
                })
                .catch(() => {})
            }
          })
          .catch((error) => {
            if (cancelled || !mountedRef.current) return
            setBootError(errorText(error))
            setLoadingBoard(false)
          })
        return () => {
          cancelled = true
        }
      }, [reloadKey, loadBoard])

      useEffect(() => {
        const element = stageRef.current
        if (!element) return
        const measure = () => {
          const rect = element.getBoundingClientRect()
          if (!rect.width || !rect.height) return
          const size = { w: rect.width, h: rect.height }
          stageSizeRef.current = size
          setStageSize(size)
          if (pendingFitRef.current && boardRef.current) {
            pendingFitRef.current = false
            const next = fitViewport(boardRef.current.nodes, size)
            viewportRef.current = next
            setViewport(next)
          }
        }
        measure()
        let observer = null
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure)
          observer.observe(element)
        }
        window.addEventListener('resize', measure)
        return () => {
          if (observer) observer.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [])

      useEffect(() => {
        const element = stageRef.current
        if (!element) return
        const onWheel = (event) => {
          if (event.target && event.target.closest && event.target.closest('.cc-node, .cc-dock, .cc-modal, .cc-backdrop')) return
          if (event.ctrlKey || event.metaKey || !event.shiftKey) {
            event.preventDefault()
            const rect = element.getBoundingClientRect()
            const mx = event.clientX - rect.left
            const my = event.clientY - rect.top
            const current = viewportRef.current
            const factor = Math.exp(-event.deltaY * 0.0014)
            const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
            const x = mx - (mx - current.x) * (scale / current.scale)
            const y = my - (my - current.y) * (scale / current.scale)
            const next = { x, y, scale }
            viewportRef.current = next
            setViewport(next)
            persist(false)
          } else {
            event.preventDefault()
            const current = viewportRef.current
            const next = { ...current, x: current.x - event.deltaY }
            viewportRef.current = next
            setViewport(next)
          }
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [persist])

      useEffect(() => {
        return () => {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          if (toastTimer.current) clearTimeout(toastTimer.current)
          streamsRef.current.forEach((controller) => {
            try {
              controller.abort()
            } catch {
              /* already aborted */
            }
          })
          streamsRef.current.clear()
        }
      }, [])

      useEffect(() => {
        const flush = () => {
          const current = boardRef.current
          if (!current) return
          try {
            fetch(`${API}/board`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ board: { ...current, viewport: viewportRef.current } }),
              keepalive: true,
            }).catch(() => {})
          } catch {
            /* best effort */
          }
        }
        window.addEventListener('pagehide', flush)
        return () => window.removeEventListener('pagehide', flush)
      }, [])

      const runStream = useCallback(
        async (nodeId, messages, selection, boardId) => {
          const targetBoardId = boardId || (boardRef.current && boardRef.current.id)
          if (!targetBoardId) return
          const controller = new AbortController()
          streamsRef.current.set(nodeId, controller)
          streamBoardRef.current.set(nodeId, targetBoardId)
          setActiveStreams((count) => count + 1)
          updateNodeScoped(targetBoardId, nodeId, {
            streaming: true,
            answer: '',
            reasoning: '',
            error: '',
            provider: selection.provider,
            model: selection.model,
          })
          try {
            await streamChat(
              {
                provider: selection.provider,
                model: selection.model,
                messages,
                system: SYSTEM_PROMPT,
                temperature: 0.8,
              },
              controller.signal,
              (event) => {
                if (!mountedRef.current) return
                if (event.type === 'text' && event.text) {
                  updateNodeScoped(targetBoardId, nodeId, (node) => ({ answer: node.answer + event.text, updatedAt: new Date().toISOString() }))
                } else if (event.type === 'reasoning' && event.text) {
                  updateNodeScoped(targetBoardId, nodeId, (node) => ({ reasoning: node.reasoning + event.text }))
                } else if (event.type === 'usage' && event.usage) {
                  updateNodeScoped(targetBoardId, nodeId, { usage: event.usage })
                } else if (event.type === 'error' && event.message) {
                  updateNodeScoped(targetBoardId, nodeId, { error: event.message })
                }
              }
            )
          } catch (error) {
            if (!mountedRef.current) return
            if (error && error.name === 'AbortError') {
              /* the stop button already cleared the streaming flag */
            } else {
              updateNodeScoped(targetBoardId, nodeId, { error: errorText(error) })
            }
          } finally {
            streamsRef.current.delete(nodeId)
            streamBoardRef.current.delete(nodeId)
            if (mountedRef.current) {
              setActiveStreams((count) => Math.max(0, count - 1))
              updateNodeScoped(targetBoardId, nodeId, { streaming: false, updatedAt: new Date().toISOString() })
              if (boardRef.current && boardRef.current.id === targetBoardId) {
                setSaveState('pending')
                setTimeout(() => {
                  if (boardRef.current && boardRef.current.id === targetBoardId) persist(true)
                  else void saveBoardById(targetBoardId)
                }, 220)
              } else {
                void saveBoardById(targetBoardId)
              }
            }
          }
        },
        [persist, saveBoardById, updateNodeScoped]
      )

      const childSlotFor = useCallback((parentId) => {
        const nodes = (boardRef.current && boardRef.current.nodes) || []
        const parent = nodes.find((node) => node.id === parentId)
        if (!parent) return rootSlot(nodes, stageSizeRef.current, viewportRef.current)
        return childSlot(parent, nodes)
      }, [])

      const revealNode = useCallback((node, parent) => {
        const size = stageSizeRef.current
        const current = viewportRef.current
        const group = parent ? [parent, node] : ((boardRef.current && boardRef.current.nodes) || [node])
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        group.forEach((item) => {
          minX = Math.min(minX, item.x)
          minY = Math.min(minY, item.y)
          maxX = Math.max(maxX, item.x + NODE_W)
          maxY = Math.max(maxY, item.y + NODE_H)
        })
        const margin = 84
        const sx = minX * current.scale + current.x
        const sy = minY * current.scale + current.y
        const ex = maxX * current.scale + current.x
        const ey = maxY * current.scale + current.y
        if (sx > margin && sy > margin && ex < size.w - margin && ey < size.h - margin) {
          return
        }
        const fitScale = Math.min(
          (size.w - margin * 2) / Math.max(1, maxX - minX),
          (size.h - margin * 2) / Math.max(1, maxY - minY)
        )
        const scale = clamp(Math.min(current.scale, fitScale), MIN_SCALE, MAX_SCALE)
        const target = {
          scale,
          x: (size.w - (maxX - minX) * scale) / 2 - minX * scale,
          y: (size.h - (maxY - minY) * scale) / 2 - minY * scale,
        }
        animateViewport(target)
      }, [])

      const animateViewport = useCallback((target) => {
        const start = { ...viewportRef.current }
        const started = performance.now()
        const duration = 280
        const tick = (now) => {
          if (!mountedRef.current) return
          const t = clamp((now - started) / duration, 0, 1)
          const eased = 1 - Math.pow(1 - t, 3)
          const next = {
            x: start.x + (target.x - start.x) * eased,
            y: start.y + (target.y - start.y) * eased,
            scale: start.scale + (target.scale - start.scale) * eased,
          }
          viewportRef.current = next
          setViewport(next)
          if (t < 1) requestAnimationFrame(tick)
          else persist(false)
        }
        requestAnimationFrame(tick)
      }, [persist])

      const sendPrompt = useCallback(
        (parentId, rawText, rawAttachments) => {
          const attachments = Array.isArray(rawAttachments) ? rawAttachments.slice(0, MAX_ATTACHMENTS) : []
          const text = String(rawText || '').trim() || (attachments.length ? L('请查看附件。', 'Please look at the attachment.') : '')
          if (!text) return
          const selection = modelRef.current
          if (!selection || !selection.provider || !selection.model) {
            setModal({ type: 'models' })
            notify(L('先选择一个模型，再开始。', 'Choose a model first.'), 'warn')
            return
          }
          const current = boardRef.current
          if (!current) return
          const parent = parentId ? current.nodes.find((node) => node.id === parentId) : null
          let position
          if (parentId) {
            position = childSlotFor(parentId)
          } else if (composerWorldRef.current) {
            position = composerWorldRef.current
          } else {
            position = rootSlot(current.nodes, stageSizeRef.current, viewportRef.current)
          }
          position = dropSlot(current.nodes, position.x, position.y)
          const timestamp = new Date().toISOString()
          const node = {
            id: uid('n'),
            parentId: parentId || null,
            prompt: text,
            attachments,
            answer: '',
            reasoning: '',
            provider: selection.provider,
            model: selection.model,
            x: position.x,
            y: position.y,
            createdAt: timestamp,
            updatedAt: timestamp,
            streaming: true,
            error: '',
            usage: null,
          }
          const firstNode = current.nodes.length === 0
          commit(
            (prev) => ({
              ...prev,
              title:
                firstNode || !prev.title || prev.title === L('未命名画布', 'Untitled canvas')
                  ? text.replace(/\s+/g, ' ').slice(0, 30)
                  : prev.title,
              nodes: prev.nodes.concat(node),
            }),
            { save: false }
          )
          setComposer(null)
          composerWorldRef.current = null
          setHeroDraft('')
          setHeroAttachments([])
          setSelectedId(node.id)
          const messages = buildMessages(current.nodes, parentId).concat([{ role: 'user', content: text, attachments }])
          void runStream(node.id, messages, selection, current.id)
          setTimeout(() => revealNode(node, parent), 30)
        },
        [childSlotFor, commit, notify, revealNode, runStream]
      )

      const openComposer = useCallback((parentId) => {
        composerWorldRef.current = null
        setComposer({ parentId: parentId || null, draft: '', attachments: [], key: Date.now() })
        setSelectedId(parentId || null)
      }, [])

      const openRootAt = useCallback((world) => {
        composerWorldRef.current = world
        setComposer({ parentId: null, draft: '', attachments: [], key: Date.now() })
      }, [])

      const stopNode = useCallback(
        (id) => {
          const controller = streamsRef.current.get(id)
          const boardId = streamBoardRef.current.get(id) || (boardRef.current && boardRef.current.id)
          if (controller) controller.abort()
          streamsRef.current.delete(id)
          streamBoardRef.current.delete(id)
          updateNodeScoped(boardId, id, { streaming: false })
          notify(L('已停止生成。', 'Generation stopped.'), 'info')
        },
        [notify, updateNodeScoped]
      )

      const regenerate = useCallback(
        (id) => {
          const current = boardRef.current
          if (!current) return
          const node = current.nodes.find((item) => item.id === id)
          if (!node) return
          const selection = modelRef.current
          if (!selection) {
            setModal({ type: 'models' })
            return
          }
          const existing = streamsRef.current.get(id)
          if (existing) existing.abort()
          const messages = buildMessages(current.nodes, node.parentId).concat([
            { role: 'user', content: node.prompt, attachments: node.attachments || [] },
          ])
          void runStream(id, messages, selection, current.id)
        },
        [runStream]
      )

      const deleteNode = useCallback(
        (id) => {
          const current = boardRef.current
          if (!current) return
          const target = current.nodes.find((node) => node.id === id)
          const doomed = descendantsOf(current.nodes, id)
          const aside = isAsideNode(target)
          setModal({
            type: 'confirm',
            title: aside ? L('删除这段临时对话？', 'Delete this side thread?') : L('删除这个分支？', 'Delete this branch?'),
            message: aside
              ? L('这段已保存的临时对话会从画布上移除，不能撤销；主对话不受影响。', 'This saved side thread will be removed from the canvas. The main conversation is not affected.')
              : doomed.size > 1
                ? L(`这会同时删除从这里长出的 ${doomed.size - 1} 个下游节点，不能撤销。`, `This also removes ${doomed.size - 1} downstream node(s). It cannot be undone.`)
                : L('这个节点会被永久删除，不能撤销。', 'This node will be deleted permanently. It cannot be undone.'),
            confirmLabel: L('删除', 'Delete'),
            danger: true,
            onConfirm: () => {
              commit(
                (prev) => ({
                  ...prev,
                  nodes: prev.nodes.filter((node) => !doomed.has(node.id)),
                }),
                { save: true, immediate: true }
              )
              setSelectedId(null)
              setModal(null)
            },
          })
        },
        [commit]
      )

      const createBoard = useCallback(() => {
        const active = boardRef.current
        if (active) {
          boardCacheRef.current.set(active.id, { ...active, viewport: viewportRef.current })
          void saveBoardById(active.id)
        }
        const fresh = blankBoard()
        boardRef.current = fresh
        setBoard(fresh)
        setSelectedId(null)
        setComposer(null)
        setHeroDraft('')
        setModal(null)
        const vp = { x: 0, y: 0, scale: 0.9 }
        viewportRef.current = vp
        setViewport(vp)
        writeLS(STORE_BOARD, fresh.id)
        setBoot((prev) => (prev ? { ...prev, boards: mergeBoardMeta(prev.boards || [], fresh) } : prev))
        setTimeout(() => persist(true), 40)
      }, [persist, saveBoardById])

      const deleteBoard = useCallback(
        (id) => {
          setModal({
            type: 'confirm',
            title: L('删除画布？', 'Delete canvas?'),
            message: L('这个画布中的全部节点都会被删除，不能撤销。', 'Every node in this canvas will be deleted. It cannot be undone.'),
            confirmLabel: L('删除画布', 'Delete canvas'),
            danger: true,
            onConfirm: () => {
              setModal(null)
              boardCacheRef.current.delete(id)
              api(`/board?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((error) => notify(errorText(error), 'error'))
              const wasCurrent = boardRef.current && boardRef.current.id === id
              if (wasCurrent) {
                const fresh = blankBoard()
                boardRef.current = fresh
                setBoard(fresh)
                setSelectedId(null)
                writeLS(STORE_BOARD, fresh.id)
                setBoot((prev) =>
                  prev
                    ? { ...prev, boards: mergeBoardMeta((prev.boards || []).filter((board) => board.id !== id), fresh) }
                    : prev
                )
                setTimeout(() => persist(true), 40)
              } else {
                setBoot((prev) =>
                  prev ? { ...prev, boards: (prev.boards || []).filter((board) => board.id !== id) } : prev
                )
              }
            },
          })
        },
        [notify, persist]
      )

      const renameBoard = useCallback(
        (title) => {
          commit({ title }, { save: true, immediate: true })
          setModal(null)
          notify(L('已重命名。', 'Renamed.'), 'success')
        },
        [commit, notify]
      )

      const tidyLayout = useCallback(() => {
        const current = boardRef.current
        if (!current || !current.nodes.length) return
        const positions = layoutTree(current.nodes)
        commit(
          (prev) => ({
            ...prev,
            nodes: prev.nodes.map((node) => (positions[node.id] ? { ...node, ...positions[node.id] } : node)),
          }),
          { save: true }
        )
        setTimeout(() => {
          const size = stageSizeRef.current
          const next = fitViewport(boardRef.current.nodes.map((node) => ({ ...node, ...(positions[node.id] || {}) })), size)
          animateViewport(next)
        }, 60)
        notify(L('已整理成一棵树。', 'Tree layout applied.'), 'success')
      }, [animateViewport, commit, notify])

      const fit = useCallback(() => {
        const current = boardRef.current
        if (!current) return
        animateViewport(fitViewport(current.nodes, stageSizeRef.current))
      }, [animateViewport])

      const centerOn = useCallback(
        (world) => {
          const size = stageSizeRef.current
          const current = viewportRef.current
          animateViewport({
            scale: current.scale,
            x: size.w / 2 - world.x * current.scale,
            y: size.h / 2 - world.y * current.scale,
          })
        },
        [animateViewport]
      )

      const zoomBy = useCallback(
        (factor) => {
          const size = stageSizeRef.current
          const current = viewportRef.current
          const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
          const cx = size.w / 2
          const cy = size.h / 2
          const next = {
            scale,
            x: cx - (cx - current.x) * (scale / current.scale),
            y: cy - (cy - current.y) * (scale / current.scale),
          }
          animateViewport(next)
        },
        [animateViewport]
      )

      const onStagePointerDown = useCallback((event) => {
        if (event.button !== 0 && event.button !== 1) return
        if (event.target.closest('.cc-node') || event.target.closest('.cc-dock') || event.target.closest('button')) return
        panRef.current = { sx: event.clientX, sy: event.clientY, ox: viewportRef.current.x, oy: viewportRef.current.y }
        setPanning(true)
        setSelectedId(null)
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* pointer capture is best effort */
        }
      }, [])

      const onStagePointerMove = useCallback((event) => {
        const pan = panRef.current
        if (!pan) return
        const next = {
          ...viewportRef.current,
          x: pan.ox + (event.clientX - pan.sx),
          y: pan.oy + (event.clientY - pan.sy),
        }
        viewportRef.current = next
        setViewport(next)
      }, [])

      const endPan = useCallback(() => {
        if (!panRef.current) return
        panRef.current = null
        setPanning(false)
        persist(false)
      }, [persist])

      const onStageDoubleClick = useCallback(
        (event) => {
          if (event.target.closest('.cc-node') || event.target.closest('.cc-dock')) return
          const size = stageSizeRef.current
          const current = viewportRef.current
          const left = (event.clientX - (event.currentTarget.getBoundingClientRect().left + current.x)) / current.scale
          const top = (event.clientY - (event.currentTarget.getBoundingClientRect().top + current.y)) / current.scale
          openRootAt({ x: left, y: top })
        },
        [openRootAt]
      )

      const openReader = useCallback((id) => {
        setModal({ type: 'reader', nodeId: id })
      }, [])

      const onNodeDragStart = useCallback((event, node) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = { id: node.id, sx: event.clientX, sy: event.clientY, ox: node.x, oy: node.y }
        setDraggingId(node.id)
        setSelectedId(node.id)
      }, [])

      useEffect(() => {
        if (!draggingId) return
        const move = (event) => {
          const drag = dragRef.current
          if (!drag) return
          const scale = viewportRef.current.scale
          const dx = (event.clientX - drag.sx) / scale
          const dy = (event.clientY - drag.sy) / scale
          const x = drag.ox + dx
          const y = drag.oy + dy
          commit((prev) => ({
            ...prev,
            nodes: prev.nodes.map((node) => (node.id === drag.id ? { ...node, x, y } : node)),
          }))
        }
        const up = () => {
          dragRef.current = null
          setDraggingId(null)
          persist(false)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up, { once: true })
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      }, [draggingId, commit, persist])

      const modelLabel = useMemo(() => {
        if (!model || !model.provider || !model.model) return ''
        const found = ((boot && boot.providers) || []).find((provider) => provider.id === model.provider)
        if (!found) return model.model
        const item = (found.models || []).find((entry) => entry.id === model.model)
        return (item && (item.name || item.id)) || model.model
      }, [boot, model])

      const modelLabelFor = useCallback(
        (node) => {
          if (!node.provider || !node.model) return ''
          const found = ((boot && boot.providers) || []).find((provider) => provider.id === node.provider)
          if (!found) return node.model
          const item = (found.models || []).find((entry) => entry.id === node.model)
          return (item && (item.name || item.id)) || node.model
        },
        [boot]
      )

      const nodes = (board && board.nodes) || []
      const selectedNode = nodes.find((node) => node.id === selectedId) || null
      const activeEdges = useMemo(() => {
        const set = new Set()
        if (!selectedId) return set
        let current = nodes.find((node) => node.id === selectedId)
        let guard = 0
        while (current && current.parentId && guard < 400) {
          set.add(current.id)
          current = nodes.find((node) => node.id === current.parentId)
          guard += 1
        }
        return set
      }, [nodes, selectedId])

      const focusSet = useMemo(() => {
        if (!focusId) return null
        const set = new Set()
        const focusNode = nodes.find((node) => node.id === focusId)
        if (focusNode && isAsideNode(focusNode)) {
          if (focusNode.anchorId) pathTo(nodes, focusNode.anchorId).forEach((node) => set.add(node.id))
          set.add(focusNode.id)
        } else {
          pathTo(nodes, focusId).forEach((node) => set.add(node.id))
          descendantsOf(nodes, focusId).forEach((id) => set.add(id))
        }
        nodes.forEach((node) => {
          if (isAsideNode(node) && node.anchorId && set.has(node.anchorId)) set.add(node.id)
        })
        return set
      }, [nodes, focusId])

      useEffect(() => {
        if (focusId && !nodes.some((node) => node.id === focusId)) setFocusId(null)
      }, [focusId, nodes])

      const finderResults = useMemo(() => {
        if (!finderOpen) return []
        const query = finderQuery.trim().toLowerCase()
        const sorted = nodes.slice().sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
        if (!query) return sorted.slice(0, 12)
        return sorted
          .filter((node) => `${node.prompt || ''}\n${String(node.answer || '').slice(0, 24000)}`.toLowerCase().includes(query))
          .slice(0, 24)
      }, [nodes, finderQuery, finderOpen])

      const clearNativeSelection = useCallback(() => {
        try {
          const selection = window.getSelection()
          if (selection) selection.removeAllRanges()
        } catch {
          /* selection is best effort */
        }
      }, [])

      const showSelectionMenu = useCallback((nodeId, container) => {
        if (!container) return
        const selection = window.getSelection()
        if (!selection || !selection.rangeCount || selection.isCollapsed) {
          setSelectionMenu(null)
          return
        }
        const quote = selection.toString().replace(/\s+/g, ' ').trim()
        if (quote.length < 2) {
          setSelectionMenu(null)
          return
        }
        const inside = (node) => {
          if (!node) return false
          const element = node.nodeType === 3 ? node.parentNode : node
          return !!element && container.contains(element)
        }
        if (!inside(selection.anchorNode) || !inside(selection.focusNode)) return
        const rect = selection.getRangeAt(0).getBoundingClientRect()
        if (!rect || (!rect.width && !rect.height)) return
        const root = document.querySelector('.cc-root')
        const rootRect = root ? root.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        const localTop = rect.top - rootRect.top
        const localBottom = rect.bottom - rootRect.top
        const above = localTop > 150
        const maxX = Math.max(170, rootRect.width - 190)
        setSelectionMenu({
          nodeId,
          quote: quote.slice(0, MAX_SELECTION_CHARS),
          x: clamp(rect.left - rootRect.left + rect.width / 2, 170, maxX),
          y: above ? localTop - 12 : Math.min(localBottom + 12, Math.max(140, rootRect.height - 126)),
          placement: above ? 'above' : 'below',
        })
      }, [])

      const closeAside = useCallback(() => {
        if (asideStreamRef.current) {
          try {
            asideStreamRef.current.abort()
          } catch {
            /* already aborted */
          }
          asideStreamRef.current = null
        }
        asideRef.current = null
        setAside(null)
        setSelectionMenu(null)
      }, [])

      const openAside = useCallback(
        (nodeId, quote, mode) => {
          if (!quote) return
          if (asideStreamRef.current) {
            try {
              asideStreamRef.current.abort()
            } catch {
              /* already aborted */
            }
            asideStreamRef.current = null
          }
          const draft =
            mode === 'translate'
              ? L('请翻译这段内容，并说明它在原句中的含义。', 'Translate this passage and explain what it means in context.')
              : mode === 'explain'
                ? L('请解释这段内容在上下文中的含义。', 'Explain what this passage means in context.')
                : ''
          const nextAside = {
            id: uid('a'),
            nodeId,
            quote,
            draft,
            messages: [],
            streaming: false,
            error: '',
            createdAt: new Date().toISOString(),
          }
          asideRef.current = nextAside
          setAside(nextAside)
          setSelectedId(nodeId)
          setSelectionMenu(null)
          setModal(null)
          clearNativeSelection()
        },
        [clearNativeSelection]
      )

      const openSavedAside = useCallback(
        (nodeId) => {
          const currentBoard = boardRef.current
          if (!currentBoard) return
          const saved = currentBoard.nodes.find((node) => node.id === nodeId && isAsideNode(node))
          if (!saved) return
          if (asideStreamRef.current) {
            try {
              asideStreamRef.current.abort()
            } catch {
              /* already aborted */
            }
            asideStreamRef.current = null
          }
          const source = saved.anchorId
            ? currentBoard.nodes.find((node) => node.id === saved.anchorId && !isAsideNode(node))
            : null
          const history = asideMessages(saved)
            .filter((message) => message && message.content && String(message.content).trim())
            .map((message) => ({
              id: uid('m'),
              role: message.role === 'assistant' ? 'assistant' : 'user',
              content: String(message.content),
            }))
          const nextAside = {
            id: uid('a'),
            nodeId: source ? source.id : null,
            quote: saved.quote || asideQuestion(saved),
            draft: '',
            messages: history,
            streaming: false,
            error: '',
            savedNodeId: saved.id,
            createdAt: saved.createdAt || new Date().toISOString(),
            provider: saved.provider || '',
            model: saved.model || '',
          }
          asideRef.current = nextAside
          setAside(nextAside)
          setSelectedId(saved.id)
          setSelectionMenu(null)
          setModal(null)
          clearNativeSelection()
        },
        [clearNativeSelection]
      )

      const sendAside = useCallback(async () => {
        const current = asideRef.current
        const currentBoard = boardRef.current
        if (!current || !currentBoard || current.streaming) return
        const prompt = current.draft.trim()
        if (!prompt) return
        const asideId = current.id
        const source = current.nodeId
          ? currentBoard.nodes.find((node) => node.id === current.nodeId && !isAsideNode(node))
          : null
        if (!source && !current.messages.some((message) => message && message.content)) {
          notify(L('原节点已经不存在了。', 'The source node no longer exists.'), 'warn')
          return
        }
        const selection = modelRef.current
        if (!selection || !selection.provider || !selection.model) {
          setModal({ type: 'models' })
          notify(L('先选择一个模型，再继续。', 'Choose a model first.'), 'warn')
          return
        }
        const history = current.messages
          .filter((message) => message && message.content && message.content.trim())
          .map((message) => ({ role: message.role, content: message.content }))
        const firstUserContent = `选中内容：\n"""${current.quote}"""\n\n我的问题：${prompt}`
        const baseMessages = source ? buildMessages(currentBoard.nodes, current.nodeId) : []
        const messages = baseMessages
          .concat(history)
          .concat([{ role: 'user', content: history.length ? prompt : firstUserContent }])
        const system = `${SYSTEM_PROMPT}\n\n${ASIDE_SYSTEM}\n\n主对话中被选中的片段：\n"""${current.quote}"""`
        const userMessage = { id: uid('m'), role: 'user', content: prompt }
        const assistantMessage = { id: uid('m'), role: 'assistant', content: '' }
        const controller = new AbortController()
        asideStreamRef.current = controller
        setAside((prev) =>
          prev && prev.id === asideId
            ? {
                ...prev,
                draft: '',
                streaming: true,
                error: '',
                provider: selection.provider,
                model: selection.model,
                messages: prev.messages.concat([userMessage, assistantMessage]),
              }
            : prev
        )
        try {
          await streamChat(
            {
              provider: selection.provider,
              model: selection.model,
              messages,
              system,
              temperature: 0.6,
            },
            controller.signal,
            (event) => {
              if (!mountedRef.current) return
              if (event.type === 'text' && event.text) {
                setAside((prev) =>
                  prev && prev.id === asideId
                    ? {
                        ...prev,
                        messages: prev.messages.map((message) =>
                          message.id === assistantMessage.id ? { ...message, content: message.content + event.text } : message
                        ),
                      }
                    : prev
                )
              } else if (event.type === 'error' && event.message) {
                setAside((prev) => (prev && prev.id === asideId ? { ...prev, error: event.message } : prev))
              }
            }
          )
        } catch (error) {
          if (mountedRef.current && error && error.name !== 'AbortError') {
            setAside((prev) => (prev && prev.id === asideId ? { ...prev, error: errorText(error) } : prev))
          }
        } finally {
          if (asideStreamRef.current === controller) asideStreamRef.current = null
          if (mountedRef.current) {
            setAside((prev) => (prev && prev.id === asideId ? { ...prev, streaming: false } : prev))
          }
        }
      }, [notify])

      const stopAside = useCallback(() => {
        if (asideStreamRef.current) {
          try {
            asideStreamRef.current.abort()
          } catch {
            /* already aborted */
          }
          asideStreamRef.current = null
        }
        setAside((prev) => (prev ? { ...prev, streaming: false } : prev))
      }, [])

      const saveAside = useCallback(() => {
        const currentAside = asideRef.current
        const currentBoard = boardRef.current
        if (!currentAside || !currentBoard) return
        if (currentAside.streaming) return
        const cleanMessages = (currentAside.messages || [])
          .filter((message) => message && message.content && String(message.content).trim())
          .slice(-40)
          .map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: String(message.content).slice(0, 60000),
          }))
        if (!cleanMessages.some((message) => message.role === 'assistant')) {
          notify(L('先让这段临时对话产生回答，再保存。', 'Wait for a side answer before saving.'), 'warn')
          return
        }
        const source = currentBoard.nodes.find((node) => node.id === currentAside.nodeId && !isAsideNode(node))
        const existingId = currentAside.savedNodeId
        const existing = existingId ? currentBoard.nodes.find((node) => node.id === existingId) : null
        if (!source && !existing) {
          notify(L('原节点已经不存在了，无法定位这段临时对话。', 'The source node no longer exists.'), 'warn')
          return
        }
        const firstUser = cleanMessages.find((message) => message.role === 'user')
        const prompt = (firstUser && firstUser.content) || currentAside.quote
        const snapshot = {
          kind: 'aside',
          quote: currentAside.quote,
          messages: cleanMessages,
          answer: asidePreview({ messages: cleanMessages }),
        }
        const transcript = asideTranscript(snapshot)
        const timestamp = new Date().toISOString()
        const selection = currentAside.provider && currentAside.model
          ? { provider: currentAside.provider, model: currentAside.model }
          : modelRef.current || {}
        let savedNode
        let created = false
        if (existing) {
          savedNode = {
            ...existing,
            quote: currentAside.quote,
            prompt,
            answer: transcript,
            messages: cleanMessages,
            anchorId: source ? source.id : existing.anchorId || null,
            provider: selection.provider || existing.provider || '',
            model: selection.model || existing.model || '',
            error: '',
            updatedAt: timestamp,
          }
        } else {
          const desiredX = source.x
          const desiredY = source.y + NODE_H + 76
          const position = dropSlot(currentBoard.nodes, desiredX, desiredY)
          savedNode = {
            id: uid('n'),
            kind: 'aside',
            anchorId: source.id,
            quote: currentAside.quote,
            prompt,
            answer: transcript,
            messages: cleanMessages,
            attachments: [],
            provider: selection.provider || source.provider || '',
            model: selection.model || source.model || '',
            x: position.x,
            y: position.y,
            createdAt: timestamp,
            updatedAt: timestamp,
            error: '',
            usage: null,
          }
          created = true
        }
        commit(
          (prev) => ({
            ...prev,
            nodes: created
              ? prev.nodes.concat(savedNode)
              : prev.nodes.map((node) => (node.id === savedNode.id ? savedNode : node)),
          }),
          { save: true, immediate: true }
        )
        const nextAside = { ...currentAside, savedNodeId: savedNode.id }
        asideRef.current = nextAside
        setAside((prev) => (prev && prev.id === currentAside.id ? { ...prev, savedNodeId: savedNode.id } : prev))
        notify(
          created
            ? L('已保存到画布，显示为独立的临时对话卡片。', 'Saved to the canvas as an independent side-thread card.')
            : L('已更新画布上的临时对话卡片。', 'Updated the saved side-thread card.'),
          'ok'
        )
        if (created) {
          setTimeout(() => {
            if (asideRef.current && asideRef.current.id === currentAside.id) revealNode(savedNode, source)
          }, 60)
        }
      }, [commit, notify, revealNode])

      const centerNode = useCallback(
        (node, scale) => {
          if (!node) return
          const size = stageSizeRef.current
          const nextScale = clamp(scale || Math.max(0.72, viewportRef.current.scale), MIN_SCALE, MAX_SCALE)
          animateViewport({
            scale: nextScale,
            x: size.w / 2 - (node.x + NODE_W / 2) * nextScale,
            y: size.h / 2 - (node.y + NODE_H / 2) * nextScale,
          })
        },
        [animateViewport]
      )

      const locateAside = useCallback(() => {
        const current = asideRef.current
        if (!current) return
        const source = nodes.find((node) => node.id === current.nodeId)
        if (source) {
          setSelectedId(source.id)
          centerNode(source, 0.9)
        }
      }, [centerNode, nodes])

      const resetZoom = useCallback(() => {
        const node = selectedId ? nodes.find((item) => item.id === selectedId) : null
        if (node) {
          centerNode(node, 1)
          return
        }
        const size = stageSizeRef.current
        const current = viewportRef.current
        const centerX = (size.w / 2 - current.x) / current.scale
        const centerY = (size.h / 2 - current.y) / current.scale
        animateViewport({ scale: 1, x: size.w / 2 - centerX, y: size.h / 2 - centerY })
      }, [animateViewport, centerNode, nodes, selectedId])

      const focusBranch = useCallback(
        (id) => {
          const node = nodes.find((item) => item.id === id)
          if (!node) return
          const set = new Set()
          if (isAsideNode(node)) {
            if (node.anchorId) pathTo(nodes, node.anchorId).forEach((item) => set.add(item.id))
            set.add(node.id)
          } else {
            pathTo(nodes, id).forEach((item) => set.add(item.id))
            descendantsOf(nodes, id).forEach((item) => set.add(item))
          }
          nodes.forEach((item) => {
            if (isAsideNode(item) && item.anchorId && set.has(item.anchorId)) set.add(item.id)
          })
          const visible = nodes.filter((item) => set.has(item.id))
          setFocusId(id)
          setSelectedId(id)
          setTimeout(() => {
            animateViewport(fitViewport(visible, stageSizeRef.current))
          }, 20)
        },
        [animateViewport, nodes]
      )

      const exitFocus = useCallback(() => {
        setFocusId(null)
        setTimeout(() => {
          animateViewport(fitViewport(boardRef.current ? boardRef.current.nodes : [], stageSizeRef.current))
        }, 20)
      }, [animateViewport])

      const chooseFinderResult = useCallback(
        (node) => {
          if (!node) return
          setFinderOpen(false)
          setFinderQuery('')
          setFinderIndex(0)
          setFocusId(null)
          setSelectedId(node.id)
          centerNode(node, Math.max(0.78, Math.min(1.05, viewportRef.current.scale)))
        },
        [centerNode]
      )

      useEffect(() => {
        if (!selectionMenu) return
        const close = (event) => {
          if (event.target && event.target.closest && event.target.closest('.cc-selection-menu')) return
          setSelectionMenu(null)
        }
        document.addEventListener('pointerdown', close, true)
        return () => document.removeEventListener('pointerdown', close, true)
      }, [selectionMenu])

      useEffect(() => {
        const onKeyDown = (event) => {
          if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'f') {
            event.preventDefault()
            setFinderOpen(true)
            setFinderQuery('')
            setFinderIndex(0)
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      const parentForComposer = composer && composer.parentId ? nodes.find((node) => node.id === composer.parentId) : null
      const selectedPath = selectedId ? pathTo(nodes, selectedId) : []
      const focusedNode = focusId ? nodes.find((node) => node.id === focusId) : null
      const asideSource = aside && aside.nodeId ? nodes.find((node) => node.id === aside.nodeId && !isAsideNode(node)) : null
      const asideContextCount = asideSource ? pathTo(nodes, asideSource.id).length : 0
      const contextCount = composer && composer.parentId ? pathTo(nodes, composer.parentId).length : 0
      const canSend = !!(model && model.provider && model.model)
      const currentBoardTitle = (board && board.title) || L('未命名画布', 'Untitled canvas')
      const gridStyle = {
        backgroundSize: `${28 * viewport.scale}px ${28 * viewport.scale}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }

      if (bootError) {
        return h(
          'div',
          { className: 'cc-root cc-center' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'cc-fatal' },
            h(Icon, { name: 'warning', size: 26 }),
            h('h2', null, L('画布没有连上宿主', 'Canvas could not reach the host')),
            h('p', null, bootError),
            h(
              'button',
              { type: 'button', className: 'cc-primary', onClick: () => setReloadKey((value) => value + 1) },
              L('重试', 'Retry')
            )
          )
        )
      }

      return h(
        'div',
        { className: cls('cc-root', aside && 'has-aside', focusSet && 'has-focus', finderOpen && 'has-finder') },
        h('style', null, CSS),
        h(
          'header',
          { className: 'cc-top' },
          h(
            'div',
            { className: 'cc-brand' },
            h(BrandMark, { size: 26 }),
            h(
              'div',
              { className: 'cc-brand-text' },
              h('span', { className: 'cc-brand-name' }, L('画布分叉聊天', 'Branching Canvas')),
              h('span', { className: 'cc-brand-sub' }, 'BRANCHING CANVAS')
            )
          ),
          h('span', { className: 'cc-top-sep' }),
          h(
            'button',
            { type: 'button', className: 'cc-board-btn', onClick: () => setModal({ type: 'boards' }), title: L('切换画布', 'Switch canvas'), 'aria-label': `${L('切换画布', 'Switch canvas')}: ${currentBoardTitle}` },
            h(Icon, { name: 'layers', size: 15 }),
            h('span', { className: 'cc-board-title' }, currentBoardTitle),
            h('span', { className: 'cc-board-count' }, L(`${nodes.length} 个节点`, `${nodes.length} nodes`)),
            h(Icon, { name: 'chevron', size: 13 })
          ),
          h('span', { className: 'cc-spacer' }),
          activeStreams
            ? h(
                'span',
                { className: 'cc-live', title: L('后台生成不会因为切换画布而中断', 'Background generation keeps running across canvases') },
                h('i', null),
                L(`${activeStreams} 个生成中`, `${activeStreams} generating`)
              )
            : null,
          h(
            'span',
            { className: cls('cc-save', saveState) },
            h('i', null),
            saveState === 'saving'
              ? L('保存中…', 'Saving…')
              : saveState === 'error'
                ? L('保存失败', 'Save failed')
                : saveState === 'pending'
                  ? L('有改动', 'Unsaved')
                  : L('已保存', 'Saved')
          ),
          h(
            'button',
            { type: 'button', className: 'cc-chip', onClick: () => setModal({ type: 'models' }), title: L('切换模型', 'Switch model'), 'aria-label': `${L('切换模型', 'Switch model')}: ${modelLabel || L('未选择', 'none')}` },
            h(Icon, { name: 'spark', size: 14 }),
            h('span', { className: 'cc-chip-text' }, modelLabel || L('选择模型', 'Choose model')),
            h(Icon, { name: 'chevron', size: 13 })
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cc-iconbtn cc-search-btn',
              title: L('搜索画布（Ctrl+F）', 'Search canvas (Ctrl+F)'),
              'aria-label': L('搜索画布', 'Search canvas'),
              onClick: () => {
                setFinderOpen(true)
                setFinderQuery('')
                setFinderIndex(0)
              },
            },
            h(Icon, { name: 'search', size: 18 })
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cc-iconbtn cc-help-btn',
              title: L('帮助', 'Help'),
              'aria-label': L('帮助', 'Help'),
              onClick: () => setModal({ type: 'help' }),
            },
            h(Icon, { name: 'help', size: 18 })
          ),
          h(
            'button',
            { type: 'button', className: 'cc-primary', onClick: () => openComposer(null), title: L('新话题', 'New topic'), 'aria-label': L('新话题', 'New topic') },
            h(Icon, { name: 'plus', size: 16 }),
            h('span', { className: 'cc-primary-label' }, L('新话题', 'New topic'))
          )
        ),
        h(
          'div',
          {
            className: cls('cc-stage', panning && 'is-panning', draggingId && 'is-dragging', focusSet && 'is-focused'),
            ref: stageRef,
            onPointerDown: onStagePointerDown,
            onPointerMove: onStagePointerMove,
            onPointerUp: endPan,
            onPointerCancel: endPan,
            onDoubleClick: onStageDoubleClick,
          },
          h('div', { className: 'cc-grid', style: gridStyle }),
          selectedPath.length && !isAsideNode(selectedNode)
            ? h(
                'div',
                { className: 'cc-breadcrumb' },
                h(Icon, { name: 'branch', size: 12 }),
                selectedPath.slice(-4).map((item, index, list) =>
                  h(
                    React.Fragment,
                    { key: item.id },
                    index > 0 ? h('span', { className: 'cc-breadcrumb-sep' }, '›') : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: cls('cc-breadcrumb-item', item.id === selectedId && 'is-current'),
                        title: (item.prompt || item.answer || '').replace(/\s+/g, ' ').slice(0, 100),
                        onClick: () => {
                          setSelectedId(item.id)
                          centerNode(item, Math.max(0.8, Math.min(1.05, viewportRef.current.scale)))
                        },
                      },
                      (item.prompt || item.answer || L('空节点', 'Empty')).replace(/\s+/g, ' ').slice(0, 18)
                    )
                  )
                ),
                h('span', { className: 'cc-breadcrumb-count' }, L(`${selectedPath.length} 轮`, `${selectedPath.length} turns`))
              )
            : null,
          focusedNode
            ? h(
                'div',
                { className: 'cc-focus-chip' },
                h(Icon, { name: 'focus', size: 12 }),
                h('span', { className: 'cc-focus-chip-label' }, L('聚焦中', 'Focused')),
                h('span', { className: 'cc-focus-chip-text' }, (focusedNode.prompt || focusedNode.answer || '').replace(/\s+/g, ' ').slice(0, 30)),
                h('button', { type: 'button', onClick: exitFocus }, L('退出', 'Exit'))
              )
            : null,
          h(
            'div',
            { className: 'cc-world', style: { transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})` } },
            h(Edges, { nodes, activeEdges, focusSet }),
            nodes.map((node) =>
              h(NodeCard, {
                key: node.id,
                node,
                selected: node.id === selectedId,
                dimmed: !!(focusSet && !focusSet.has(node.id)),
                hasAside: !!(aside && aside.nodeId === node.id),
                isRoot: !node.parentId,
                modelLabel: modelLabelFor(node),
                onSelect: (id) => {
                  setSelectedId(id)
                  if (focusSet && !focusSet.has(id)) setFocusId(null)
                },
                onDragStart: onNodeDragStart,
                onBranch: openComposer,
                onRegenerate: regenerate,
                onStop: stopNode,
                onDelete: deleteNode,
                onExpand: openReader,
                onFocus: focusBranch,
                onTextSelect: showSelectionMenu,
                onContinueAside: openSavedAside,
                onExport: (id) => setModal({ type: 'export', nodeId: id }),
              })
            )
          ),
          nodes.length === 0 && !loadingBoard && !composer
            ? h(Hero, {
                draft: heroDraft,
                attachments: heroAttachments,
                uploading,
                onDraft: setHeroDraft,
                onSend: (text, attachments) => sendPrompt(null, text, attachments),
                onAttach: (files) => attachFiles(files, 'hero'),
                onRemoveAttachment: (id) => removeAttachment('hero', id),
                canSend,
                modelLabel,
                onPickModel: () => setModal({ type: 'models' }),
              })
            : null,
          loadingBoard
            ? h(
                'div',
                { className: 'cc-loading' },
                h('div', { className: 'cc-spinner' }),
                h('span', null, L('正在展开画布…', 'Opening canvas…'))
              )
            : null,
          nodes.length
            ? h(
                'div',
                { className: 'cc-hint' },
                h(Icon, { name: 'map', size: 13 }),
                L('拖动空白处平移 · 滚轮缩放 · 双击画布新建话题', 'Drag to pan · Wheel to zoom · Double-click to start a topic')
              )
            : null
        ),
        selectionMenu
          ? h(
              'div',
              {
                className: cls('cc-selection-menu', selectionMenu.placement === 'below' && 'is-below'),
                style: { left: selectionMenu.x, top: selectionMenu.y },
                onMouseDown: (event) => event.preventDefault(),
              },
              h('div', { className: 'cc-selection-quote' }, `“${selectionMenu.quote.slice(0, 64)}${selectionMenu.quote.length > 64 ? '…' : ''}”`),
              h(
                'div',
                { className: 'cc-selection-actions' },
                h(
                  'button',
                  { type: 'button', className: 'cc-selection-action is-primary', onClick: () => openAside(selectionMenu.nodeId, selectionMenu.quote, 'ask') },
                  h(Icon, { name: 'quote', size: 13 }),
                  L('针对这段提问', 'Ask about this')
                ),
                h(
                  'button',
                  { type: 'button', className: 'cc-selection-action', onClick: () => openAside(selectionMenu.nodeId, selectionMenu.quote, 'translate') },
                  h(Icon, { name: 'arrow', size: 13 }),
                  L('翻译', 'Translate')
                ),
                h(
                  'button',
                  { type: 'button', className: 'cc-selection-action', onClick: () => openAside(selectionMenu.nodeId, selectionMenu.quote, 'explain') },
                  h(Icon, { name: 'spark', size: 13 }),
                  L('解释', 'Explain')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-selection-action is-icon',
                    title: L('复制选中文字', 'Copy selection'),
                    'aria-label': L('复制选中文字', 'Copy selection'),
                    onClick: async () => {
                      const copied = await copyText(selectionMenu.quote)
                      setSelectionMenu(null)
                      notify(
                        copied ? L('已复制选中文字。', 'Selection copied.') : L('复制失败，请手动选择复制。', 'Copy failed. Select and copy manually.'),
                        copied ? 'success' : 'warn'
                      )
                    },
                  },
                  h(Icon, { name: 'copy', size: 13 })
                )
              )
            )
          : null,
        aside
          ? h(AsidePanel, {
              aside,
              source: asideSource,
              contextCount: asideContextCount,
              modelLabel,
              saved: !!aside.savedNodeId,
              canSave: !aside.streaming && (aside.messages || []).some((message) => message.role === 'assistant' && String(message.content || '').trim()),
              onSave: saveAside,
              onClose: closeAside,
              onDraft: (draft) => {
                if (asideRef.current) asideRef.current = { ...asideRef.current, draft }
                setAside((prev) => (prev ? { ...prev, draft } : prev))
              },
              onSend: sendAside,
              onStop: stopAside,
              onLocate: locateAside,
            })
          : null,
        finderOpen
          ? h(
              'div',
              {
                className: 'cc-finder-layer',
                onPointerDown: (event) => {
                  if (event.target === event.currentTarget) setFinderOpen(false)
                },
              },
              h(
                'div',
                { className: 'cc-finder', role: 'dialog', 'aria-label': L('搜索画布', 'Search canvas') },
                h(
                  'div',
                  { className: 'cc-finder-input' },
                  h(Icon, { name: 'search', size: 17 }),
                  h('input', {
                    autoFocus: true,
                    value: finderQuery,
                    placeholder: L('搜索问题或回答…', 'Search prompts or answers…'),
                    onChange: (event) => {
                      setFinderQuery(event.target.value)
                      setFinderIndex(0)
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setFinderOpen(false)
                      } else if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setFinderIndex((index) => Math.min(finderResults.length - 1, index + 1))
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        setFinderIndex((index) => Math.max(0, index - 1))
                      } else if (event.key === 'Enter') {
                        event.preventDefault()
                        chooseFinderResult(finderResults[finderIndex] || finderResults[0])
                      }
                    },
                  }),
                  h('span', { className: 'cc-finder-count' }, `${finderResults.length}`)
                ),
                h(
                  'div',
                  { className: 'cc-finder-results' },
                  finderResults.length
                    ? finderResults.map((node, index) =>
                        h(
                          'button',
                          {
                            key: node.id,
                            type: 'button',
                            className: cls('cc-finder-item', isAsideNode(node) && 'is-aside', index === finderIndex && 'is-active'),
                            onMouseEnter: () => setFinderIndex(index),
                            onClick: () => chooseFinderResult(node),
                          },
                          h(
                            'div',
                            { className: 'cc-finder-item-top' },
                            h(Icon, { name: isAsideNode(node) ? 'quote' : node.parentId ? 'branch' : 'spark', size: 12 }),
                            h('span', { className: 'cc-finder-item-prompt' }, (node.prompt || L('（空）', '(empty)')).replace(/\s+/g, ' ').slice(0, 80)),
                            h('span', { className: 'cc-finder-item-time' }, formatTime(node.updatedAt || node.createdAt))
                          ),
                          h(
                            'div',
                            { className: 'cc-finder-item-answer' },
                            (node.answer || L('（还没有回答）', '(no answer yet)')).replace(/\s+/g, ' ').slice(0, 110)
                          )
                        )
                      )
                    : h('div', { className: 'cc-finder-empty' }, h(Icon, { name: 'search', size: 20 }), h('span', null, L('没有匹配的对话。', 'No matching conversation.')))
                ),
                h('div', { className: 'cc-finder-foot' }, h('kbd', null, 'Ctrl+F'), L('搜索 · ↑↓ 选择 · Enter 跳转 · Esc 关闭', 'Search · ↑↓ select · Enter jump · Esc close'))
              )
            )
          : null,
        nodes.length && !aside
          ? h(Minimap, { nodes, viewport, stageSize, onNavigate: centerOn })
          : null,
        nodes.length
          ? h(
              'div',
              { className: 'cc-zoom' },
              h(
                'button',
                { type: 'button', className: 'cc-iconbtn', title: L('缩小', 'Zoom out'), onClick: () => zoomBy(0.85) },
                h('span', { className: 'cc-zoom-glyph' }, '−')
              ),
              h('span', { className: 'cc-zoom-value' }, `${Math.round(viewport.scale * 100)}%`),
              h(
                'button',
                { type: 'button', className: 'cc-iconbtn', title: L('放大', 'Zoom in'), onClick: () => zoomBy(1.18) },
                h('span', { className: 'cc-zoom-glyph' }, '+')
              ),
              h('span', { className: 'cc-zoom-divider' }),
              h(
                'button',
                { type: 'button', className: 'cc-iconbtn', title: L('适配视图', 'Fit view'), onClick: fit },
                h(Icon, { name: 'fit', size: 16 })
              ),
              h(
                'button',
                { type: 'button', className: 'cc-iconbtn cc-zoom-100', title: L('实际大小 100%', 'Actual size 100%'), onClick: resetZoom },
                h('span', null, '1:1')
              ),
              h(
                'button',
                { type: 'button', className: 'cc-iconbtn', title: L('整理成树', 'Tree layout'), onClick: tidyLayout },
                h(Icon, { name: 'grid', size: 16 })
              ),
              h(
                'button',
                { type: 'button', className: 'cc-iconbtn', title: L('画布列表', 'Canvas list'), onClick: () => setModal({ type: 'boards' }) },
                h(Icon, { name: 'layers', size: 16 })
              )
            )
          : null,
        composer
          ? h(ComposerDock, {
              composer,
              parent: parentForComposer,
              contextCount,
              modelLabel,
              canSend,
              uploading,
              onDraft: (draft) => setComposer((prev) => (prev ? { ...prev, draft } : prev)),
              onSend: (text, attachments) => sendPrompt(composer.parentId, text, attachments),
              onAttach: (files) => attachFiles(files, 'composer'),
              onRemoveAttachment: (id) => removeAttachment('composer', id),
              onClose: () => setComposer(null),
              onPickModel: () => setModal({ type: 'models' }),
            })
          : null,
        toast
          ? h('div', { className: cls('cc-toast', toast.kind) }, h(Icon, { name: toast.kind === 'error' ? 'warning' : toast.kind === 'success' ? 'check' : 'spark', size: 15 }), h('span', null, toast.message))
          : null,
        modal && modal.type === 'models'
          ? h(ModelModal, {
              catalog: boot || { providers: [], hasLlm: false },
              value: model,
              onClose: () => setModal(null),
              onPick: (selection) => {
                modelRef.current = selection
                setModel(selection)
                writeLS(STORE_MODEL, selection)
                setModal(null)
                notify(L('模型已切换。', 'Model switched.'), 'success')
              },
            })
          : null,
        modal && modal.type === 'boards'
          ? h(BoardModal, {
              boards: (boot && boot.boards) || [],
              current: board,
              onClose: () => setModal(null),
              onOpen: (id) => {
                setModal(null)
                void loadBoard(id)
              },
              onCreate: createBoard,
              onDelete: deleteBoard,
              onRename: renameBoard,
            })
          : null,
        modal && modal.type === 'reader'
          ? (() => {
              const node = nodes.find((item) => item.id === modal.nodeId)
              if (!node) return null
              return h(ReaderModal, {
                node,
                modelLabel: modelLabelFor(node),
                onClose: () => setModal(null),
                onBranch: (id) => {
                  setModal(null)
                  openComposer(id)
                },
                onRegenerate: (id) => {
                  setModal(null)
                  regenerate(id)
                },
                onTextSelect: showSelectionMenu,
                onContinue: (id) => {
                  setModal(null)
                  openSavedAside(id)
                },
                onExport: (id) => setModal({ type: 'export', nodeId: id }),
              })
            })()
          : null,
        modal && modal.type === 'export'
          ? (() => {
              const node = nodes.find((item) => item.id === modal.nodeId)
              if (!node) return null
              return h(ExportModal, { key: node.id, node, board, onClose: () => setModal(null) })
            })()
          : null,
        modal && modal.type === 'help' ? h(HelpModal, { onClose: () => setModal(null) }) : null,
        modal && modal.type === 'confirm'
          ? h(ConfirmModal, {
              title: modal.title,
              message: modal.message,
              confirmLabel: modal.confirmLabel,
              danger: modal.danger,
              onClose: () => setModal(null),
              onConfirm: modal.onConfirm,
            })
          : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* Sidebar icon                                                        */
    /* ------------------------------------------------------------------ */

    function CanvasSidebarIcon({ size, active }) {
      const edge = typeof size === 'number' && size > 0 ? size : 22
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { opacity: active ? 1 : 0.82 },
        },
        h('path', { d: 'M5.2 6.4h4.1a3 3 0 0 1 3 3v5.2a3 3 0 0 0 3 3h3.5' }),
        h('path', { d: 'M12.3 9.4h2.6a2.4 2.4 0 0 0 2.4-2.4V6.3' }),
        h('circle', { cx: '5.2', cy: '6.4', r: '2.2' }),
        h('circle', { cx: '12.3', cy: '14.6', r: '1.7' }),
        h('circle', { cx: '18.8', cy: '17.6', r: '2.2' }),
        h('circle', { cx: '17.3', cy: '4.3', r: '1.5' })
      )
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = String.raw`
.cc-root {
  --cc-accent: #4f7cff;
  --cc-teal: #16b8a6;
  --cc-violet: #8b5cff;
  --cc-surface: rgba(255, 255, 255, 0.9);
  --cc-surface-2: rgba(244, 247, 253, 0.92);
  --cc-border: rgba(15, 23, 42, 0.1);
  --cc-border-strong: rgba(15, 23, 42, 0.16);
  --cc-text: #111827;
  --cc-muted: #5b6472;
  --cc-danger: #e5484d;
  --cc-dot: rgba(30, 41, 59, 0.14);
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--cc-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(1100px 560px at 8% -14%, rgba(79, 124, 255, 0.14), transparent 62%),
    radial-gradient(900px 520px at 108% 4%, rgba(22, 184, 166, 0.11), transparent 60%),
    linear-gradient(180deg, rgba(251, 252, 255, 0.88), rgba(246, 248, 253, 0.94));
  backdrop-filter: blur(30px) saturate(1.06);
  -webkit-backdrop-filter: blur(30px) saturate(1.06);
}

html[data-ds-theme-source="dark"] .cc-root {
  --cc-surface: rgba(25, 28, 36, 0.9);
  --cc-surface-2: rgba(33, 37, 47, 0.92);
  --cc-border: rgba(255, 255, 255, 0.12);
  --cc-border-strong: rgba(255, 255, 255, 0.2);
  --cc-text: #f2f4f9;
  --cc-muted: #a0a8b8;
  --cc-dot: rgba(255, 255, 255, 0.12);
  background:
    radial-gradient(1100px 560px at 8% -14%, rgba(79, 124, 255, 0.2), transparent 62%),
    radial-gradient(900px 520px at 108% 4%, rgba(22, 184, 166, 0.14), transparent 60%),
    linear-gradient(180deg, rgba(15, 17, 23, 0.9), rgba(12, 14, 19, 0.95));
}

html[data-ds-theme-source="dark"] .cc-top { background: rgba(17, 20, 27, 0.62); }
html[data-ds-theme-source="dark"] .cc-node-head { background: rgba(24, 27, 35, 0.82); }
html[data-ds-theme-source="dark"] .cc-node-foot { background: rgba(24, 27, 35, 0.72); }
html[data-ds-theme-source="dark"] .cc-composer { background: rgba(24, 27, 35, 0.9); }
html[data-ds-theme-source="dark"] .cc-hero-composer { background: rgba(24, 27, 35, 0.82); }
html[data-ds-theme-source="dark"] .cc-suggestion { background: rgba(24, 27, 35, 0.6); }
html[data-ds-theme-source="dark"] .cc-modal { background: rgba(20, 23, 30, 0.97); }
html[data-ds-theme-source="dark"] .cc-export-format { background: rgba(255, 255, 255, 0.035); }
html[data-ds-theme-source="dark"] .cc-export-format.is-active { background: rgba(193, 116, 22, .14); }
html[data-ds-theme-source="dark"] .cc-export-title { background: rgba(255, 255, 255, 0.04); }
html[data-ds-theme-source="dark"] .cc-export-note { color: #e0b36e; }
html[data-ds-theme-source="dark"] .cc-export-foot { background: rgba(255, 255, 255, 0.025); }
html[data-ds-theme-source="dark"] .cc-minimap { background: rgba(20, 23, 30, 0.76); }
html[data-ds-theme-source="dark"] .cc-minimap-bg { fill: rgba(15, 18, 24, 0.6); }
html[data-ds-theme-source="dark"] .cc-zoom { background: rgba(20, 23, 30, 0.78); }
html[data-ds-theme-source="dark"] .cc-hint { background: rgba(20, 23, 30, 0.7); }
html[data-ds-theme-source="dark"] .cc-toast { background: rgba(20, 23, 30, 0.96); }
html[data-ds-theme-source="dark"] .cc-board-row { background: rgba(255, 255, 255, 0.04); }
html[data-ds-theme-source="dark"] .cc-reader-prompt { background: rgba(255, 255, 255, 0.05); }

.cc-root * { box-sizing: border-box; }
.cc-root button, .cc-root input, .cc-root textarea { font-family: inherit; color: inherit; }
.cc-root button { cursor: pointer; }
.cc-root button:disabled { cursor: default; }
.cc-root svg { display: block; }
.cc-spacer { flex: 1 1 auto; min-width: 0; }
.cc-icon { flex: none; }

.cc-top {
  position: relative;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 58px;
  padding: 0 14px;
  flex: none;
  border-bottom: 1px solid var(--cc-border);
  background: rgba(255, 255, 255, 0.56);
  backdrop-filter: blur(22px) saturate(1.12);
  -webkit-backdrop-filter: blur(22px) saturate(1.12);
}

.cc-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.cc-brandmark { flex: none; filter: drop-shadow(0 4px 10px color-mix(in oklab, var(--cc-accent) 35%, transparent)); }
.cc-brand-text { display: flex; flex-direction: column; line-height: 1.05; min-width: 0; }
.cc-brand-name { font-size: 14.5px; font-weight: 650; letter-spacing: 0.2px; white-space: nowrap; }
.cc-brand-sub { font-size: 8.5px; letter-spacing: 1.6px; color: var(--cc-muted); opacity: 0.72; margin-top: 3px; }
.cc-top-sep { width: 1px; height: 22px; background: var(--cc-border); margin: 0 2px; flex: none; }

.cc-board-btn {
  display: flex; align-items: center; gap: 7px;
  height: 34px; max-width: 340px; padding: 0 10px;
  border: 1px solid transparent; border-radius: 10px;
  background: transparent; color: var(--cc-text);
  transition: background .15s ease, border-color .15s ease;
}
.cc-board-btn:hover { background: var(--cc-surface-2); border-color: var(--cc-border); }
.cc-board-title { font-weight: 600; font-size: 13.5px; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-board-count { display: none; }
.cc-board-btn .cc-icon:last-child { color: var(--cc-muted); }

.cc-live { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 1px solid color-mix(in oklab, var(--cc-teal) 26%, var(--cc-border)); border-radius: 999px; background: color-mix(in oklab, var(--cc-teal) 9%, transparent); color: color-mix(in oklab, var(--cc-teal) 72%, var(--cc-text)); font-size: 9.5px; font-weight: 650; white-space: nowrap; }
.cc-live i { width: 5px; height: 5px; border-radius: 50%; background: var(--cc-teal); animation: cc-pulse 1.2s ease-in-out infinite; }

.cc-save { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--cc-muted); white-space: nowrap; margin-right: 2px; }
.cc-save i { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in oklab, var(--dsw-alias-state-success-primary) 16%, transparent); }
.cc-save.saving i { background: var(--dsw-alias-state-warn-primary); animation: cc-pulse 1.1s ease-in-out infinite; }
.cc-save.pending i { background: var(--dsw-alias-state-idle-primary); }
.cc-save.error i { background: var(--cc-danger); box-shadow: 0 0 0 3px color-mix(in oklab, var(--cc-danger) 16%, transparent); }

.cc-chip {
  display: inline-flex; align-items: center; gap: 7px;
  height: 34px; padding: 0 11px; max-width: 260px;
  border: 1px solid var(--cc-border); border-radius: 10px;
  background: var(--cc-surface); color: var(--cc-text);
  font-size: 12.5px; white-space: nowrap;
  transition: border-color .15s ease, background .15s ease, transform .15s ease;
}
.cc-chip:hover { border-color: var(--cc-border-strong); background: var(--cc-surface-2); }
.cc-chip .cc-icon:first-child { color: var(--cc-violet); }
.cc-chip .cc-icon:last-child { color: var(--cc-muted); }
.cc-chip-text { max-width: 170px; overflow: hidden; text-overflow: ellipsis; }
.cc-chip.is-subtle { background: transparent; border-color: transparent; padding: 0 7px; height: 28px; color: var(--cc-muted); }
.cc-chip.is-subtle:hover { background: var(--cc-surface-2); color: var(--cc-text); }

.cc-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; flex: none;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--cc-muted);
  transition: color .15s ease, background .15s ease, border-color .15s ease;
  padding: 0;
}
.cc-iconbtn:hover { color: var(--cc-text); background: var(--cc-surface-2); border-color: var(--cc-border); }
.cc-iconbtn.is-danger:hover { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 34%, transparent); background: color-mix(in oklab, var(--cc-danger) 9%, transparent); }
.cc-iconbtn.is-armed { color: var(--cc-danger); background: color-mix(in oklab, var(--cc-danger) 12%, transparent); }
.cc-help-btn { width: 34px; height: 34px; }

.cc-primary {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 14px; flex: none;
  border: 1px solid transparent; border-radius: 10px;
  background: linear-gradient(135deg, var(--cc-accent), color-mix(in oklab, var(--cc-violet) 74%, var(--cc-accent)));
  color: #fff; font-size: 12.5px; font-weight: 600;
  box-shadow: 0 6px 18px -8px color-mix(in oklab, var(--cc-accent) 70%, transparent), inset 0 1px 0 rgba(255,255,255,.16);
  transition: filter .15s ease, transform .15s ease, box-shadow .15s ease;
}
.cc-primary:hover { filter: brightness(1.06); transform: translateY(-1px); }
.cc-primary:active { transform: translateY(0); }
.cc-primary:disabled { opacity: .44; filter: none; transform: none; cursor: default; }
.cc-primary.is-small { height: 32px; padding: 0 12px; font-size: 12px; }
.cc-primary.is-danger { background: var(--cc-danger); box-shadow: none; }

.cc-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.cc-stage.is-panning { cursor: grabbing; }
.cc-stage.is-dragging { cursor: default; }
.cc-grid {
  position: absolute; inset: 0;
  background-image: radial-gradient(circle, var(--cc-dot) 1px, transparent 1.2px);
  opacity: .8;
  pointer-events: none;
}
.cc-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.cc-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.cc-edge-shadow { fill: none; stroke: color-mix(in oklab, var(--cc-accent) 9%, transparent); stroke-width: 7; }
.cc-edge-line { fill: none; stroke: color-mix(in oklab, var(--cc-accent) 45%, var(--cc-border-strong)); stroke-width: 1.7; vector-effect: non-scaling-stroke; transition: stroke .2s ease, stroke-width .2s ease; }
.cc-edge-dot { fill: color-mix(in oklab, var(--cc-accent) 52%, var(--dsw-alias-bg-base)); stroke: var(--dsw-alias-bg-base); stroke-width: 1; }
.cc-edge.is-active .cc-edge-line { stroke: var(--cc-accent); stroke-width: 2.2; }
.cc-edge.is-active .cc-edge-dot { fill: var(--cc-accent); }
.cc-edge.is-streaming .cc-edge-line { stroke: var(--cc-teal); stroke-width: 2; stroke-dasharray: 7 6; animation: cc-dash 1.1s linear infinite; }
.cc-edge.is-streaming .cc-edge-dot { fill: var(--cc-teal); }

.cc-node {
  position: absolute; left: 0; top: 0;
  width: 392px; height: 336px;
  display: flex; flex-direction: column;
  border: 1px solid var(--cc-border);
  border-radius: 18px;
  background: var(--cc-surface);
  backdrop-filter: blur(24px) saturate(1.1);
  -webkit-backdrop-filter: blur(24px) saturate(1.1);
  box-shadow: 0 18px 40px -26px rgba(8, 12, 30, .45), 0 3px 8px -4px rgba(8, 12, 30, .1);
  overflow: hidden;
  transition: border-color .18s ease, box-shadow .2s ease;
  user-select: text;
}
.cc-node::after {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--cc-accent), var(--cc-teal), transparent);
  opacity: 0; transition: opacity .2s ease; pointer-events: none;
}
.cc-node:hover { border-color: var(--cc-border-strong); box-shadow: 0 22px 46px -26px rgba(8, 12, 30, .55), 0 4px 10px -4px rgba(8, 12, 30, .14); }
.cc-node.is-selected { border-color: color-mix(in oklab, var(--cc-accent) 62%, var(--cc-border)); box-shadow: 0 0 0 3px color-mix(in oklab, var(--cc-accent) 16%, transparent), 0 24px 50px -26px rgba(8, 12, 30, .55); z-index: 6; }
.cc-stage.is-dragging .cc-node.is-selected { z-index: 40; }
.cc-node.is-streaming { border-color: color-mix(in oklab, var(--cc-teal) 48%, var(--cc-border)); }
.cc-node.is-streaming::after { opacity: 1; animation: cc-scan 2.4s linear infinite; }
.cc-node.has-error { border-color: color-mix(in oklab, var(--cc-danger) 42%, var(--cc-border)); }
.cc-node-head {
  display: flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 10px 0 11px; flex: none;
  border-bottom: 1px solid var(--cc-border);
  background: rgba(247, 249, 253, 0.74);
  cursor: grab;
}
.cc-stage.is-dragging .cc-node-head { cursor: grabbing; }
.cc-node-badge { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 8px; flex: none; }
.cc-node-badge.is-root { color: #fff; background: linear-gradient(135deg, var(--cc-accent), var(--cc-violet)); box-shadow: 0 4px 10px -4px color-mix(in oklab, var(--cc-accent) 70%, transparent); }
.cc-node-badge.is-child { color: var(--cc-teal); background: color-mix(in oklab, var(--cc-teal) 13%, transparent); border: 1px solid color-mix(in oklab, var(--cc-teal) 24%, transparent); }
.cc-node-meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; gap: 3px; }
.cc-node-kind { font-size: 10.5px; font-weight: 650; letter-spacing: .4px; color: var(--cc-muted); text-transform: uppercase; }
.cc-node-model { font-size: 10.5px; color: var(--cc-muted); max-width: 168px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .92; }
.cc-node-actions { display: flex; align-items: center; gap: 1px; margin-left: auto; opacity: 0; transform: translateX(3px); transition: opacity .15s ease, transform .15s ease; }
.cc-node:hover .cc-node-actions, .cc-node.is-selected .cc-node-actions { opacity: 1; transform: none; }
.cc-node-actions .cc-iconbtn { width: 26px; height: 26px; }

/* Saved side threads: a deliberately different, warm note card. */
.cc-node.cc-aside-card {
  border: 1.5px dashed rgba(193, 116, 22, .48);
  background: linear-gradient(162deg, rgba(255, 253, 247, .98), rgba(255, 247, 232, .94));
  box-shadow: 0 18px 40px -26px rgba(88, 53, 10, .38), 0 3px 8px -4px rgba(88, 53, 10, .08);
}
.cc-node.cc-aside-card::after {
  opacity: .75;
  background: linear-gradient(90deg, transparent, #d97706, #f0b35a, transparent);
}
.cc-node.cc-aside-card:hover { border-color: rgba(193, 116, 22, .7); }
.cc-node.cc-aside-card.is-selected {
  border-color: #d97706;
  box-shadow: 0 0 0 3px rgba(217, 119, 6, .16), 0 22px 46px -26px rgba(88, 53, 10, .45);
}
.cc-aside-card-head { background: rgba(255, 248, 235, .84); border-bottom: 1px dashed rgba(193, 116, 22, .32); }
.cc-aside-badge { color: #a35f06; background: rgba(245, 158, 11, .14); border: 1px solid rgba(217, 119, 6, .22); }
.cc-aside-saved-tag { display: inline-flex; align-items: center; gap: 4px; width: fit-content; color: #a35f06; font-size: 9.5px; font-weight: 700; letter-spacing: .2px; }
.cc-aside-card-prompt { max-height: 104px; padding-top: 9px; padding-bottom: 9px; border-bottom: 1px dashed rgba(193, 116, 22, .26); background: rgba(255, 251, 243, .6); }
.cc-aside-card-quote { display: flex; flex-direction: column; gap: 3px; }
.cc-aside-card-quote-label { color: #a37534; font-size: 9px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; }
.cc-aside-card-quote-text { color: #5d411b; font-size: 12px; font-weight: 550; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.cc-aside-card-thread { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 11px 14px 8px; }
.cc-aside-card-thread-meta { display: flex; align-items: center; gap: 5px; color: #a37534; font-size: 10px; font-weight: 650; margin-bottom: 5px; }
.cc-aside-card-preview { color: #4a3a25; font-size: 12.5px; line-height: 1.62; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.cc-aside-card-foot { border-top: 1px dashed rgba(193, 116, 22, .24); gap: 5px; }
.cc-aside-card-foot .cc-node-continue { height: 25px; padding: 0 7px; font-size: 10.5px; }
.cc-aside-continue { color: #fff !important; border-color: #b45309 !important; background: linear-gradient(135deg, #c17416, #b45309) !important; box-shadow: 0 4px 10px -6px rgba(120, 70, 10, .55); }
.cc-aside-continue:hover { filter: brightness(1.06); }
.cc-aside-open { color: #9a5b08 !important; border-color: rgba(217, 119, 6, .26) !important; background: rgba(217, 119, 6, .07) !important; }
.cc-aside-open:hover { background: rgba(217, 119, 6, .13) !important; }
.cc-edge.is-aside .cc-edge-line { stroke: rgba(193, 116, 22, .62); stroke-width: 1.5; stroke-dasharray: 2 6; stroke-linecap: round; }
.cc-edge.is-aside .cc-edge-shadow { stroke: rgba(193, 116, 22, .07); }
.cc-edge.is-aside .cc-edge-dot { fill: #d97706; }
.cc-edge-origin { fill: var(--dsw-alias-bg-base); stroke: #d97706; stroke-width: 1.2; }

.cc-node-prompt {
  position: relative; flex: none; max-height: 84px; overflow: auto;
  padding: 10px 14px 8px 26px;
  font-size: 13px; font-weight: 600; line-height: 1.52; color: var(--cc-text);
  border-bottom: 1px dashed color-mix(in oklab, var(--cc-border) 62%, transparent);
  white-space: pre-wrap; word-break: break-word;
}
.cc-node-grip { position: absolute; left: 6px; top: 11px; color: var(--cc-muted); opacity: .4; cursor: grab; }
.cc-node:hover .cc-node-grip { opacity: .7; }
.cc-node-prompt-text { min-height: 18px; }
.cc-muted { color: var(--cc-muted); font-weight: 400; }

/* Attachments */
.cc-file-input { display: none; }
.cc-attachments { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 14px 2px; flex: none; }
.cc-attachments.is-compact { padding: 8px 14px 4px; }
.cc-composer .cc-attachments, .cc-hero-composer .cc-attachments { padding: 2px 4px 7px; }
.cc-attach-item { position: relative; flex: none; }
.cc-attach-item.is-image { width: 56px; height: 56px; border-radius: 10px; overflow: hidden; border: 1px solid var(--cc-border); background: var(--cc-surface-2); }
.cc-attach-item.is-image img { display: block; width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
.cc-attach-item.is-file {
  display: flex; align-items: center; gap: 6px; max-width: 250px; min-height: 34px;
  padding: 5px 9px 5px 7px; border: 1px solid var(--cc-border); border-radius: 9px;
  background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 58%, transparent);
}
.cc-attach-item.is-document { border-color: color-mix(in oklab, var(--cc-accent) 26%, var(--cc-border)); background: color-mix(in oklab, var(--cc-accent) 6%, transparent); }
.cc-attach-item.is-document .cc-attach-icon { color: #b45309; }
.cc-attach-truncated { flex: none; padding: 1px 4px; border-radius: 4px; background: rgba(180, 83, 9, .11); color: #9a5b08; font-size: 9px; font-weight: 650; }
.cc-attach-icon { display: inline-flex; color: var(--cc-accent); flex: none; }
.cc-attach-name { display: flex; flex-direction: column; min-width: 0; gap: 1px; text-align: left; }
.cc-attach-name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; color: var(--cc-text); }
.cc-attach-size { font-size: 10px; color: var(--cc-muted); }
.cc-attach-remove {
  position: absolute; top: -5px; right: -5px; display: inline-flex; align-items: center; justify-content: center;
  width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--cc-border-strong);
  background: var(--cc-surface); color: var(--cc-muted); box-shadow: 0 2px 6px rgba(5, 9, 24, .16);
}
.cc-attach-remove:hover { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 45%, var(--cc-border)); }
.cc-attach-item.is-loading {
  display: grid; place-items: center; width: 56px; height: 56px; border-radius: 10px;
  border: 1px dashed var(--cc-border-strong); background: var(--cc-surface-2);
}

.cc-reasoning { flex: none; margin: 6px 12px 0; border: 1px solid var(--cc-border); border-radius: 9px; background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 54%, transparent); overflow: hidden; }
.cc-reasoning summary { display: flex; align-items: center; gap: 5px; padding: 5px 9px; font-size: 11px; color: var(--cc-muted); cursor: pointer; list-style: none; }
.cc-reasoning summary::-webkit-details-marker { display: none; }
.cc-reasoning-body { max-height: 86px; overflow: auto; padding: 0 9px 7px; font-size: 11.5px; line-height: 1.55; color: var(--cc-muted); white-space: pre-wrap; }

.cc-node-answer { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 9px 14px 12px; font-size: 13px; line-height: 1.66; user-select: text; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(100, 116, 139, .3) transparent; }
.cc-node-answer::-webkit-scrollbar { width: 6px; height: 6px; }
.cc-node-answer::-webkit-scrollbar-thumb { background: rgba(100, 116, 139, .28); border-radius: 999px; }
.cc-node-placeholder { color: var(--cc-muted); font-size: 12px; line-height: 1.6; padding-top: 4px; }
.cc-node-waiting { display: flex; align-items: center; gap: 9px; color: var(--cc-muted); font-size: 12px; padding-top: 3px; }
.cc-thinking { display: inline-flex; align-items: center; gap: 4px; }
.cc-thinking i { width: 5px; height: 5px; border-radius: 50%; background: var(--cc-teal); animation: cc-bounce 1.1s ease-in-out infinite; }
.cc-thinking i:nth-child(2) { animation-delay: .14s; }
.cc-thinking i:nth-child(3) { animation-delay: .28s; }
.cc-caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; vertical-align: -2px; border-radius: 2px; background: var(--cc-teal); animation: cc-caret .9s steps(2) infinite; }
.cc-node-error { display: flex; gap: 8px; padding: 9px 10px; border-radius: 10px; background: color-mix(in oklab, var(--cc-danger) 9%, transparent); border: 1px solid color-mix(in oklab, var(--cc-danger) 24%, transparent); color: var(--cc-danger); font-size: 12px; }
.cc-node-error-title { font-weight: 650; margin-bottom: 2px; }
.cc-node-error-text { opacity: .92; line-height: 1.5; word-break: break-word; }
.cc-node-foot {
  display: flex; align-items: center; gap: 8px; height: 38px; flex: none;
  padding: 0 10px; border-top: 1px solid var(--cc-border);
  background: rgba(247, 249, 253, 0.66);
}
.cc-node-continue {
  display: inline-flex; align-items: center; gap: 5px;
  height: 25px; padding: 0 9px; border-radius: 7px;
  border: 1px solid color-mix(in oklab, var(--cc-accent) 26%, transparent);
  background: color-mix(in oklab, var(--cc-accent) 9%, transparent);
  color: var(--cc-accent); font-size: 11.5px; font-weight: 600;
  transition: background .15s ease, border-color .15s ease;
}
.cc-node-continue:hover { background: color-mix(in oklab, var(--cc-accent) 16%, transparent); border-color: color-mix(in oklab, var(--cc-accent) 44%, transparent); }
.cc-node-export {
  display: inline-flex; align-items: center; gap: 4px; height: 25px; padding: 0 7px;
  border-radius: 7px; border: 1px solid var(--cc-border); background: transparent;
  color: var(--cc-muted); font-size: 10.5px; font-weight: 600;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.cc-node-export:hover { color: var(--cc-accent); border-color: color-mix(in oklab, var(--cc-accent) 34%, transparent); background: color-mix(in oklab, var(--cc-accent) 7%, transparent); }
.cc-node-export.is-aside { color: #9a5b08; border-color: rgba(193, 116, 22, .24); background: rgba(217, 119, 6, .06); }
.cc-node-time { margin-left: auto; font-size: 10.5px; color: var(--cc-muted); }
.cc-node-usage { font-size: 10px; color: var(--cc-muted); opacity: .8; }

.cc-md { font-size: inherit; line-height: inherit; color: inherit; word-break: break-word; }
.cc-md > *:first-child { margin-top: 0; }
.cc-md > *:last-child { margin-bottom: 0; }
.cc-md p { margin: 0.55em 0; }
.cc-md h1, .cc-md h2, .cc-md h3, .cc-md h4, .cc-md h5 { margin: 0.9em 0 0.4em; line-height: 1.35; font-weight: 650; }
.cc-md h1 { font-size: 1.32em; }
.cc-md h2 { font-size: 1.2em; }
.cc-md h3 { font-size: 1.1em; }
.cc-md h4, .cc-md h5 { font-size: 1.02em; }
.cc-md ul, .cc-md ol { margin: 0.45em 0; padding-left: 1.3em; }
.cc-md li { margin: 0.16em 0; }
.cc-md li > p { margin: 0.15em 0; }
.cc-md strong { font-weight: 650; }
.cc-md em { font-style: italic; }
.cc-md a { color: var(--cc-accent); text-decoration: none; border-bottom: 1px solid color-mix(in oklab, var(--cc-accent) 36%, transparent); }
.cc-md a:hover { border-bottom-color: var(--cc-accent); }
.cc-md hr { margin: 1em 0; border: none; border-top: 1px solid var(--cc-border); }
.cc-md blockquote { margin: 0.6em 0; padding: 2px 0 2px 10px; border-left: 2px solid color-mix(in oklab, var(--cc-accent) 50%, transparent); color: var(--cc-muted); }
.cc-inline-code { padding: 1px 5px; border-radius: 5px; background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 88%, transparent); border: 1px solid var(--cc-border); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
.cc-code { margin: 0.7em 0; border: 1px solid rgba(15, 23, 42, 0.45); border-radius: 11px; overflow: hidden; background: #0f172a; color: #e6edf7; }
.cc-code-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 9px; border-bottom: 1px solid rgba(255, 255, 255, 0.09); background: rgba(255, 255, 255, 0.05); }
.cc-code-lang { font-size: 10.5px; color: #9fb0c7; letter-spacing: .3px; text-transform: uppercase; }
.cc-code-copy { display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; color: #9fb0c7; font-size: 10.5px; padding: 2px 4px; border-radius: 5px; }
.cc-code-copy:hover { color: #ffffff; background: rgba(255, 255, 255, 0.09); }
.cc-code pre { margin: 0; padding: 10px 12px; overflow: auto; }
.cc-code code { color: #e6edf7; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.8px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.cc-table-wrap { overflow: auto; margin: 0.7em 0; }
.cc-md table { border-collapse: collapse; width: 100%; font-size: .96em; }
.cc-md th, .cc-md td { border: 1px solid var(--cc-border); padding: 5px 8px; text-align: left; vertical-align: top; }
.cc-md th { background: var(--cc-surface-2); font-weight: 600; white-space: nowrap; }
.cc-md td code { white-space: pre-wrap; overflow-wrap: anywhere; }

.cc-dock { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); width: min(720px, calc(100% - 48px)); z-index: 40; animation: cc-rise .18s ease-out; }
.cc-composer {
  border: 1px solid var(--cc-border-strong); border-radius: 19px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(30px) saturate(1.2);
  -webkit-backdrop-filter: blur(30px) saturate(1.2);
  box-shadow: 0 28px 70px -26px rgba(5, 9, 24, .45), 0 2px 10px -2px rgba(5, 9, 24, .12);
  padding: 9px 10px 9px;
  overflow: hidden;
}
.cc-composer-context { display: flex; align-items: center; gap: 7px; padding: 3px 6px 7px; color: var(--cc-muted); font-size: 11px; min-width: 0; }
.cc-composer-context .cc-icon { color: var(--cc-teal); }
.cc-composer-context-label { flex: none; font-weight: 600; color: color-mix(in oklab, var(--cc-muted) 82%, var(--cc-text)); }
.cc-composer-context-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .9; }
.cc-composer-context-count { flex: none; margin-left: auto; padding: 1px 6px; border-radius: 999px; background: var(--cc-surface-2); border: 1px solid var(--cc-border); font-size: 10px; }
.cc-composer-input {
  display: block; width: 100%; min-height: 40px; max-height: 180px;
  padding: 7px 7px 5px; border: none; outline: none; resize: none;
  background: transparent; color: var(--cc-text); font-size: 14px; line-height: 1.6;
}
.cc-composer-input::placeholder, .cc-hero-composer textarea::placeholder { color: var(--cc-muted); opacity: .8; }
.cc-composer-bar { display: flex; align-items: center; gap: 6px; padding-top: 3px; }
.cc-send {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 33px; padding: 0 14px; border: none; border-radius: 9px;
  background: linear-gradient(135deg, var(--cc-accent), color-mix(in oklab, var(--cc-violet) 70%, var(--cc-accent)));
  color: #fff; font-size: 12.5px; font-weight: 600;
  box-shadow: 0 8px 20px -10px color-mix(in oklab, var(--cc-accent) 80%, transparent);
  transition: filter .15s ease, transform .15s ease;
}
.cc-send:hover { filter: brightness(1.07); }
.cc-send:disabled { opacity: .4; filter: none; }

.cc-hero { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 28px; text-align: center; pointer-events: none; }
.cc-hero > * { pointer-events: auto; }
.cc-hero-orb { position: relative; width: 92px; height: 92px; margin-bottom: 18px; display: grid; place-items: center; animation: cc-float 5.5s ease-in-out infinite; }
.cc-hero-orb::before { content: ''; position: absolute; inset: -26px; border-radius: 50%; background: radial-gradient(circle, color-mix(in oklab, var(--cc-accent) 26%, transparent), transparent 68%); filter: blur(8px); }
.cc-hero-orb-inner { position: relative; width: 92px; height: 92px; border-radius: 30px; display: grid; place-items: center; background: color-mix(in oklab, var(--dsw-alias-bg-layer-1) 88%, transparent); border: 1px solid color-mix(in oklab, var(--cc-accent) 26%, var(--cc-border)); box-shadow: 0 20px 50px -20px color-mix(in oklab, var(--cc-accent) 60%, transparent), inset 0 1px 0 rgba(255,255,255,.12); backdrop-filter: blur(12px); }
.cc-hero-title { margin: 0; font-size: clamp(25px, 3.1vw, 36px); font-weight: 700; letter-spacing: -.6px; line-height: 1.18; background: linear-gradient(110deg, #1b2130 12%, #4f7cff 56%, #16b8a6 94%); -webkit-background-clip: text; background-clip: text; color: transparent; }
html[data-ds-theme-source="dark"] .cc-hero-title { background: linear-gradient(110deg, #f4f6fb 12%, #7ea2ff 56%, #4fe0cf 94%); -webkit-background-clip: text; background-clip: text; }
.cc-hero-sub { margin: 12px 0 22px; max-width: 560px; font-size: 13.5px; line-height: 1.7; color: var(--cc-muted); }
.cc-hero-composer { width: min(680px, 100%); border: 1px solid var(--cc-border-strong); border-radius: 18px; background: rgba(255, 255, 255, 0.84); backdrop-filter: blur(22px); box-shadow: 0 24px 60px -30px rgba(5, 9, 24, .4); padding: 8px 10px 9px; text-align: left; }
.cc-hero-composer textarea { display: block; width: 100%; min-height: 58px; max-height: 160px; resize: none; border: none; outline: none; background: transparent; color: var(--cc-text); font-size: 14px; line-height: 1.6; padding: 6px 5px; }
.cc-hero-composer-bar { display: flex; align-items: center; gap: 6px; }
.cc-hero-chips { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: min(680px, 100%); margin-top: 16px; }
.cc-suggestion { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 9px 11px; border: 1px solid var(--cc-border); border-radius: 11px; background: rgba(255, 255, 255, 0.58); color: var(--cc-muted); font-size: 11.8px; text-align: left; transition: border-color .15s ease, color .15s ease, transform .15s ease, background .15s ease; }
.cc-suggestion:hover { color: var(--cc-text); border-color: color-mix(in oklab, var(--cc-accent) 34%, var(--cc-border)); background: var(--cc-surface-2); transform: translateY(-1px); }
.cc-suggestion .cc-icon { color: var(--cc-accent); flex: none; }
.cc-suggestion span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-hero-foot { display: flex; align-items: center; gap: 6px; margin-top: 16px; font-size: 10.5px; color: var(--cc-muted); opacity: .8; }

.cc-minimap { position: absolute; right: 18px; top: 74px; z-index: 20; border-radius: 14px; border: 1px solid var(--cc-border); background: rgba(255, 255, 255, 0.72); backdrop-filter: blur(18px); box-shadow: 0 16px 40px -22px rgba(5, 9, 24, .4); overflow: hidden; opacity: .94; transition: opacity .15s ease; }
.cc-minimap:hover { opacity: 1; }
.cc-minimap svg { cursor: pointer; }
.cc-minimap-bg { fill: rgba(255, 255, 255, 0.6); }
.cc-minimap-node { fill: rgba(79, 124, 255, 0.82); }
.cc-minimap-node.is-aside { fill: rgba(217, 119, 6, 0.78); }
.cc-minimap-node.is-streaming { fill: var(--cc-teal); }
.cc-minimap-view { fill: rgba(79, 124, 255, 0.04); stroke: rgba(79, 124, 255, 0.55); stroke-width: 1; stroke-dasharray: 3 3; }

.cc-zoom { position: absolute; left: 18px; bottom: 18px; z-index: 20; display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 5px; border: 1px solid var(--cc-border); border-radius: 12px; background: rgba(255, 255, 255, 0.74); backdrop-filter: blur(20px); box-shadow: 0 14px 34px -20px rgba(5, 9, 24, .4); }
.cc-zoom .cc-iconbtn { width: 28px; height: 28px; }
.cc-zoom-glyph { font-size: 18px; line-height: 1; font-weight: 400; }
.cc-zoom-value { min-width: 40px; text-align: center; font-size: 10.5px; color: var(--cc-muted); font-variant-numeric: tabular-nums; }
.cc-zoom-divider { width: 1px; height: 18px; background: var(--cc-border); margin: 0 2px; }
.cc-hint { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); z-index: 15; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--cc-border); background: rgba(255, 255, 255, 0.66); backdrop-filter: blur(12px); font-size: 10.5px; color: var(--cc-muted); pointer-events: none; white-space: nowrap; opacity: .9; }
.cc-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: color-mix(in oklab, var(--dsw-alias-bg-base) 45%, transparent); color: var(--cc-muted); font-size: 12px; z-index: 25; }
.cc-spinner { width: 28px; height: 28px; border-radius: 50%; border: 2px solid color-mix(in oklab, var(--cc-accent) 20%, transparent); border-top-color: var(--cc-accent); animation: cc-spin .8s linear infinite; }
.cc-center { align-items: center; justify-content: center; }
.cc-fatal { max-width: 460px; text-align: center; padding: 32px; border: 1px solid var(--cc-border); border-radius: 18px; background: var(--cc-surface); box-shadow: 0 24px 60px -30px rgba(5, 9, 24, .5); color: var(--cc-danger); }
.cc-fatal h2 { margin: 12px 0 6px; font-size: 17px; color: var(--cc-text); }
.cc-fatal p { margin: 0 0 18px; font-size: 12.5px; line-height: 1.6; color: var(--cc-muted); word-break: break-word; }

.cc-toast { position: absolute; left: 50%; bottom: 112px; transform: translateX(-50%); z-index: 95; display: inline-flex; align-items: center; gap: 8px; max-width: min(560px, calc(100% - 40px)); padding: 9px 14px; border-radius: 12px; border: 1px solid var(--cc-border); background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(20px); box-shadow: 0 18px 44px -18px rgba(5, 9, 24, .4); font-size: 12px; animation: cc-rise .2s ease-out; }
.cc-toast.success .cc-icon { color: var(--dsw-alias-state-success-primary); }
.cc-toast.error { color: var(--cc-danger); border-color: color-mix(in oklab, var(--cc-danger) 30%, var(--cc-border)); }
.cc-toast.info .cc-icon { color: var(--cc-accent); }

.cc-backdrop { position: absolute; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 24px; background: color-mix(in oklab, #060a16 40%, transparent); backdrop-filter: blur(7px); animation: cc-fade .16s ease; }
.cc-modal { display: flex; flex-direction: column; width: min(640px, 100%); max-height: min(84vh, 780px); border: 1px solid var(--cc-border-strong); border-radius: 21px; background: rgba(255, 255, 255, 0.95); box-shadow: 0 40px 100px -30px rgba(3, 6, 18, .55), inset 0 1px 0 rgba(255,255,255,.6); overflow: hidden; animation: cc-pop .18s cubic-bezier(.2,.8,.2,1); }
.cc-modal-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 16px 12px 20px; flex: none; border-bottom: 1px solid color-mix(in oklab, var(--cc-border) 70%, transparent); }
.cc-modal-heading { min-width: 0; flex: 1; }
.cc-modal-title { font-size: 16px; font-weight: 680; letter-spacing: -.2px; }
.cc-modal-sub { margin-top: 4px; font-size: 11.5px; line-height: 1.55; color: var(--cc-muted); }
.cc-model-body { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: 12px 16px 14px; gap: 10px; }

.cc-export { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.cc-export-body { display: flex; flex-direction: column; gap: 10px; padding: 18px 20px 16px; overflow: auto; }
.cc-export-label { margin-top: 2px; font-size: 10.5px; font-weight: 700; letter-spacing: .5px; color: var(--cc-muted); text-transform: uppercase; }
.cc-export-formats { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.cc-export-format {
  display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding: 12px; text-align: left;
  border: 1px solid var(--cc-border); border-radius: 12px; background: var(--cc-surface-2);
  transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
}
.cc-export-format:hover { border-color: color-mix(in oklab, var(--cc-accent) 30%, var(--cc-border)); }
.cc-export-format.is-active { border-color: color-mix(in oklab, var(--cc-accent) 58%, var(--cc-border)); background: color-mix(in oklab, var(--cc-accent) 8%, var(--cc-surface)); box-shadow: 0 0 0 3px color-mix(in oklab, var(--cc-accent) 10%, transparent); }
.cc-export-format-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 34px; height: 34px; border-radius: 9px; background: color-mix(in oklab, var(--cc-accent) 11%, transparent); color: var(--cc-accent); }
.cc-export-format-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cc-export-format-copy strong { font-size: 12.5px; color: var(--cc-text); }
.cc-export-format-copy span { font-size: 10.5px; line-height: 1.45; color: var(--cc-muted); }
.cc-export-scopes { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.cc-export-scope {
  display: flex; flex-direction: column; gap: 3px; padding: 10px 11px; text-align: left;
  border: 1px solid var(--cc-border); border-radius: 10px; background: transparent; color: var(--cc-text);
}
.cc-export-scope:hover { border-color: color-mix(in oklab, var(--cc-accent) 28%, var(--cc-border)); }
.cc-export-scope.is-active { border-color: color-mix(in oklab, var(--cc-accent) 52%, var(--cc-border)); background: color-mix(in oklab, var(--cc-accent) 7%, transparent); }
.cc-export-scope strong { font-size: 11.5px; }
.cc-export-scope span { font-size: 10px; color: var(--cc-muted); }
.cc-export-title {
  width: 100%; height: 38px; padding: 0 11px; border: 1px solid var(--cc-border); border-radius: 10px;
  outline: none; background: var(--cc-surface-2); color: var(--cc-text); font-size: 13px;
}
.cc-export-title:focus { border-color: color-mix(in oklab, var(--cc-accent) 52%, var(--cc-border)); box-shadow: 0 0 0 3px color-mix(in oklab, var(--cc-accent) 11%, transparent); }
.cc-export-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 11px; border-radius: 9px; background: rgba(217, 119, 6, .07); border: 1px dashed rgba(193, 116, 22, .28); color: #8a520b; font-size: 10.5px; line-height: 1.5; }
.cc-export-result { display: flex; align-items: center; gap: 9px; padding: 10px 11px; border: 1px solid color-mix(in oklab, var(--dsw-alias-state-success-primary) 24%, var(--cc-border)); border-radius: 10px; background: color-mix(in oklab, var(--dsw-alias-state-success-primary) 7%, transparent); }
.cc-export-result-icon { display: inline-flex; color: var(--dsw-alias-state-success-primary); flex: none; }
.cc-export-result-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.cc-export-result-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.cc-export-result-copy span { font-size: 10px; color: var(--cc-muted); }
.cc-export-error { display: flex; align-items: flex-start; gap: 7px; padding: 9px 11px; border-radius: 9px; background: color-mix(in oklab, var(--cc-danger) 8%, transparent); color: var(--cc-danger); font-size: 11px; line-height: 1.5; }
.cc-export-foot { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--cc-border); flex: none; background: color-mix(in oklab, var(--cc-surface) 70%, transparent); }
.cc-export-summary { display: inline-flex; align-items: center; gap: 5px; margin-right: auto; font-size: 10.5px; color: var(--cc-muted); }
.cc-export-foot .cc-primary, .cc-export-foot .cc-secondary { height: 32px; padding: 0 12px; font-size: 11.5px; }
.cc-search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px; border: 1px solid var(--cc-border); border-radius: 10px; background: var(--cc-surface-2); color: var(--cc-muted); flex: none; }
.cc-search:focus-within { border-color: color-mix(in oklab, var(--cc-accent) 52%, var(--cc-border)); box-shadow: 0 0 0 3px color-mix(in oklab, var(--cc-accent) 12%, transparent); }
.cc-search input { flex: 1; min-width: 0; height: 100%; border: none; outline: none; background: transparent; color: var(--cc-text); font-size: 13px; }
.cc-model-scroll { flex: 1; min-height: 0; overflow: auto; margin: 0 -4px; padding: 0 4px; }
.cc-model-group { padding: 4px 0 10px; }
.cc-model-provider { display: flex; align-items: baseline; gap: 8px; padding: 8px 8px 6px; font-size: 11px; font-weight: 650; color: var(--cc-muted); letter-spacing: .3px; }
.cc-model-provider-id { font-weight: 400; opacity: .65; letter-spacing: 0; }
.cc-model-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; text-align: left; transition: background .12s ease, border-color .12s ease; }
.cc-model-row:hover { background: var(--cc-surface-2); border-color: var(--cc-border); }
.cc-model-row.is-active { background: color-mix(in oklab, var(--cc-accent) 8%, transparent); border-color: color-mix(in oklab, var(--cc-accent) 22%, transparent); }
.cc-model-row.is-active .cc-icon { color: var(--cc-accent); }
.cc-model-row-main { display: flex; flex-direction: column; min-width: 0; gap: 1px; flex: 1; }
.cc-model-name { font-size: 12.5px; font-weight: 550; }
.cc-model-id { font-size: 10.5px; color: var(--cc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-model-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 2px; flex: none; }
.cc-linkbtn { border: none; background: transparent; color: var(--cc-accent); font-size: 11.5px; padding: 2px 0; }
.cc-linkbtn:hover { text-decoration: underline; }
.cc-model-count { font-size: 10.5px; color: var(--cc-muted); }
.cc-custom-route { display: flex; gap: 7px; align-items: center; flex: none; padding-top: 4px; }
.cc-custom-route input { min-width: 0; flex: 1; height: 34px; padding: 0 9px; border: 1px solid var(--cc-border); border-radius: 8px; background: var(--cc-surface-2); color: var(--cc-text); font-size: 12px; outline: none; }
.cc-custom-route input:focus { border-color: color-mix(in oklab, var(--cc-accent) 52%, var(--cc-border)); }
.cc-empty-note { display: flex; gap: 12px; padding: 22px 16px; color: var(--cc-muted); font-size: 12px; line-height: 1.6; }
.cc-empty-note .cc-icon { color: var(--cc-accent); margin-top: 2px; }
.cc-empty-note strong { display: block; color: var(--cc-text); font-size: 13px; margin-bottom: 3px; }
.cc-empty-note p { margin: 0; }

.cc-board-body { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: 12px 16px 14px; gap: 10px; }
.cc-rename { display: flex; gap: 8px; align-items: center; flex: none; }
.cc-rename input { flex: 1; min-width: 0; height: 36px; padding: 0 10px; border: 1px solid var(--cc-border); border-radius: 9px; background: var(--cc-surface-2); color: var(--cc-text); font-size: 13px; outline: none; }
.cc-rename input:focus { border-color: color-mix(in oklab, var(--cc-accent) 52%, var(--cc-border)); }
.cc-board-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; margin: 0 -4px; padding: 0 4px; }
.cc-board-row { display: flex; align-items: center; gap: 6px; border: 1px solid var(--cc-border); border-radius: 11px; background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 38%, transparent); padding: 3px 6px 3px 3px; }
.cc-board-row.is-active { border-color: color-mix(in oklab, var(--cc-accent) 34%, var(--cc-border)); background: color-mix(in oklab, var(--cc-accent) 6%, transparent); }
.cc-board-open { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 7px 8px; border: none; background: transparent; text-align: left; border-radius: 8px; }
.cc-board-open:hover { background: var(--cc-surface-2); }
.cc-board-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; background: color-mix(in oklab, var(--cc-accent) 10%, transparent); color: var(--cc-accent); flex: none; }
.cc-board-info { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.cc-board-name { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-board-sub { font-size: 10.5px; color: var(--cc-muted); }
.cc-pill { margin-left: auto; padding: 2px 7px; border-radius: 999px; border: 1px solid color-mix(in oklab, var(--cc-accent) 32%, transparent); color: var(--cc-accent); font-size: 9.5px; flex: none; }
.cc-armed-text { font-size: 10px; font-weight: 650; }
.cc-board-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: none; padding-top: 2px; }

.cc-reader { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: 14px 20px 16px; gap: 6px; overflow: hidden; }
.cc-reader-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--cc-muted); font-weight: 650; margin-top: 6px; }
.cc-reader-prompt { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--cc-border); background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 42%, transparent); font-size: 13px; font-weight: 600; line-height: 1.6; white-space: pre-wrap; flex: none; }
.cc-reader-answer { flex: 1; min-height: 0; overflow: auto; padding-right: 6px; font-size: 13.5px; line-height: 1.75; scrollbar-width: thin; scrollbar-color: rgba(100, 116, 139, .35) transparent; }
.cc-reader-answer::-webkit-scrollbar { width: 6px; }
.cc-reader-answer::-webkit-scrollbar-thumb { background: rgba(100, 116, 139, .32); border-radius: 999px; }
.cc-reader-foot { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 12px; border-top: 1px solid var(--cc-border); flex: none; }
.cc-secondary { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 33px; padding: 0 12px; border: 1px solid var(--cc-border); border-radius: 9px; background: var(--cc-surface-2); color: var(--cc-text); font-size: 12px; }
.cc-secondary:hover { border-color: var(--cc-border-strong); background: var(--cc-surface); }
.cc-secondary:disabled { opacity: .45; }

.cc-help { display: flex; flex-direction: column; gap: 10px; padding: 16px 20px 18px; overflow: auto; }
.cc-help-concept { display: flex; gap: 12px; padding: 11px 12px; border: 1px solid var(--cc-border); border-radius: 12px; background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 32%, transparent); }
.cc-help-orb { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px; background: color-mix(in oklab, var(--cc-accent) 12%, transparent); color: var(--cc-accent); flex: none; }
.cc-help-concept strong { display: block; font-size: 12.5px; margin-bottom: 3px; }
.cc-help-concept p { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--cc-muted); }
.cc-shortcuts { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.cc-shortcut-row { display: flex; align-items: center; gap: 10px; padding: 6px 4px; font-size: 11.5px; color: var(--cc-muted); border-bottom: 1px dashed color-mix(in oklab, var(--cc-border) 60%, transparent); }
.cc-shortcut-row:last-child { border-bottom: none; }
.cc-shortcut-row kbd { flex: none; min-width: 110px; padding: 2px 6px; border: 1px solid var(--cc-border); border-bottom-width: 2px; border-radius: 5px; background: var(--cc-surface-2); color: var(--cc-text); font-family: inherit; font-size: 10.5px; }
.cc-confirm { padding: 18px 20px 20px; }
.cc-confirm p { margin: 0 0 18px; font-size: 13px; line-height: 1.65; color: var(--cc-muted); }
.cc-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }

.cc-root ::selection { background: color-mix(in oklab, var(--cc-accent) 26%, transparent); }
.cc-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.cc-root ::-webkit-scrollbar-thumb { background: color-mix(in oklab, var(--cc-muted) 26%, transparent); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
.cc-root ::-webkit-scrollbar-thumb:hover { background: color-mix(in oklab, var(--cc-muted) 42%, transparent); background-clip: padding-box; }
.cc-root ::-webkit-scrollbar-track { background: transparent; }

/* Large-canvas navigation */
.cc-node.is-dimmed { opacity: .18; filter: saturate(.35); }
.cc-node.is-dimmed:hover { opacity: .6; filter: none; }
.cc-edge.is-dimmed { opacity: .09; }
.cc-node-aside-tag { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 999px; border: 1px solid color-mix(in oklab, #d97706 38%, transparent); color: #b45309; background: color-mix(in oklab, #f59e0b 11%, transparent); font-size: 8px; font-weight: 700; letter-spacing: .3px; flex: none; }
.cc-breadcrumb { position: absolute; left: 18px; top: 12px; z-index: 18; display: flex; align-items: center; gap: 4px; max-width: min(560px, calc(100% - 220px)); padding: 4px 7px; border: 1px solid var(--cc-border); border-radius: 9px; background: rgba(255, 255, 255, 0.68); backdrop-filter: blur(14px); color: var(--cc-muted); font-size: 10px; overflow: hidden; }
.cc-breadcrumb > .cc-icon { flex: none; color: var(--cc-accent); }
.cc-breadcrumb-item { max-width: 94px; padding: 2px 3px; border: none; border-radius: 4px; background: transparent; color: var(--cc-muted); font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-breadcrumb-item:hover { color: var(--cc-text); background: var(--cc-surface-2); }
.cc-breadcrumb-item.is-current { color: var(--cc-text); font-weight: 650; }
.cc-breadcrumb-sep { opacity: .45; flex: none; }
.cc-breadcrumb-count { margin-left: 3px; padding-left: 6px; border-left: 1px solid var(--cc-border); white-space: nowrap; opacity: .75; flex: none; }
.cc-focus-chip { position: absolute; left: 18px; top: 50px; z-index: 19; display: flex; align-items: center; gap: 5px; max-width: 330px; padding: 5px 7px 5px 9px; border: 1px solid color-mix(in oklab, var(--cc-teal) 36%, var(--cc-border)); border-radius: 9px; background: rgba(255, 255, 255, 0.76); backdrop-filter: blur(14px); font-size: 10px; color: var(--cc-muted); }
.cc-focus-chip .cc-icon { color: var(--cc-teal); flex: none; }
.cc-focus-chip-label { font-weight: 700; color: var(--cc-text); white-space: nowrap; }
.cc-focus-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-focus-chip button { border: none; background: transparent; color: var(--cc-teal); font-size: 10px; font-weight: 650; padding: 0 2px; }
.cc-focus-chip button:hover { text-decoration: underline; }
.cc-search-btn { flex: none; }
.cc-zoom-100 { width: 30px !important; font-size: 8.5px; font-weight: 700; letter-spacing: -.2px; }
.cc-root.has-aside .cc-minimap, .cc-root.has-aside .cc-hint { display: none; }

/* Selection popover */
.cc-selection-menu { position: absolute; z-index: 110; width: min(340px, calc(100% - 24px)); padding: 8px; border: 1px solid color-mix(in oklab, #d97706 26%, var(--cc-border)); border-radius: 13px; background: rgba(255, 251, 244, 0.98); box-shadow: 0 18px 44px -14px rgba(67, 38, 4, .34), inset 0 1px 0 rgba(255,255,255,.7); transform: translate(-50%, -100%); animation: cc-menu-pop .14s ease-out; }
.cc-selection-menu.is-below { transform: translate(-50%, 0); animation-name: cc-menu-pop-below; }
.cc-selection-quote { padding: 3px 5px 7px; font-size: 10.5px; line-height: 1.5; color: #8a5a12; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-selection-actions { display: flex; align-items: center; gap: 4px; }
.cc-selection-action { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px; border: 1px solid rgba(180, 83, 9, .18); border-radius: 7px; background: rgba(255, 255, 255, .7); color: #7c4a08; font-size: 10.5px; font-weight: 600; white-space: nowrap; }
.cc-selection-action:hover { background: #fff; border-color: rgba(180, 83, 9, .34); }
.cc-selection-action.is-primary { background: #9a5b08; border-color: #9a5b08; color: #fff; }
.cc-selection-action.is-primary:hover { background: #7c4a08; }
.cc-selection-action.is-icon { width: 28px; padding: 0; justify-content: center; margin-left: auto; }

/* Temporary side thread */
.cc-aside-panel { position: absolute; top: 66px; right: 16px; bottom: 184px; z-index: 72; display: flex; flex-direction: column; width: min(420px, calc(100% - 32px)); min-height: 0; border: 1px solid rgba(217, 119, 6, .24); border-left: 3px solid #d97706; border-radius: 17px; background: linear-gradient(180deg, rgba(255, 252, 246, .98), rgba(255, 248, 237, .96)); box-shadow: 0 28px 70px -24px rgba(56, 32, 5, .35), inset 0 1px 0 rgba(255,255,255,.8); overflow: hidden; animation: cc-pop .18s cubic-bezier(.2,.8,.2,1); }
.cc-aside-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 12px 12px 9px 15px; border-bottom: 1px dashed rgba(217, 119, 6, .24); flex: none; }
.cc-aside-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; flex: none; }
.cc-aside-save { display: inline-flex; align-items: center; gap: 5px; height: 29px; padding: 0 9px; border: 1px solid rgba(217, 119, 6, .34); border-radius: 8px; background: rgba(245, 158, 11, .1); color: #9a5b08; font-size: 10.5px; font-weight: 700; white-space: nowrap; transition: background .15s ease, border-color .15s ease, opacity .15s ease; }
.cc-aside-save:hover { background: rgba(245, 158, 11, .18); border-color: rgba(217, 119, 6, .5); }
.cc-aside-save:disabled { opacity: .38; cursor: default; }
.cc-aside-save.is-saved { color: #7c4a05; background: rgba(245, 158, 11, .14); }
.cc-aside-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cc-aside-kicker { display: inline-flex; align-items: center; gap: 5px; color: #9a5b08; font-size: 10px; font-weight: 800; letter-spacing: 1.2px; }
.cc-aside-sub { font-size: 10px; color: #9a7a4a; }
.cc-aside-head .cc-iconbtn:hover { color: #9a5b08; background: rgba(217,119,6,.1); }
.cc-aside-quote { margin: 10px 12px 0; padding: 9px 10px; border: 1px dashed rgba(217, 119, 6, .3); border-radius: 9px; background: rgba(255, 255, 255, .56); flex: none; }
.cc-aside-quote-label { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; color: #a37534; font-size: 9px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; }
.cc-aside-quote blockquote { margin: 0; max-height: 96px; overflow: auto; padding-left: 8px; border-left: 2px solid rgba(217, 119, 6, .32); color: #6b4a1d; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.cc-aside-source { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 6px; color: #a37534; font-size: 9.5px; }
.cc-aside-source > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-aside-locate { display: inline-flex; align-items: center; gap: 3px; border: none; background: transparent; color: #9a5b08; font-size: 9.5px; padding: 0; white-space: nowrap; }
.cc-aside-locate:hover { text-decoration: underline; }
.cc-aside-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 10px; }
.cc-aside-context { display: flex; align-items: center; gap: 5px; color: #9a7a4a; font-size: 9.5px; padding-bottom: 2px; }
.cc-aside-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 24px 16px; color: #9a7a4a; }
.cc-aside-empty .cc-icon { color: #d97706; }
.cc-aside-empty strong { color: #5c3d13; font-size: 12.5px; }
.cc-aside-empty p { margin: 0; max-width: 260px; font-size: 10.5px; line-height: 1.65; }
.cc-aside-msg { display: flex; flex-direction: column; gap: 4px; max-width: 94%; }
.cc-aside-msg.is-user { align-self: flex-end; align-items: flex-end; }
.cc-aside-msg.is-assistant { align-self: flex-start; }
.cc-aside-msg-label { font-size: 8.5px; font-weight: 800; letter-spacing: .7px; color: #b08a52; text-transform: uppercase; }
.cc-aside-user-text { padding: 7px 10px; border-radius: 10px 10px 3px 10px; background: #9a5b08; color: #fff; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.cc-aside-msg.is-assistant .cc-md { font-size: 11.7px; line-height: 1.7; color: #3f2d13; }
.cc-aside-msg.is-assistant .cc-md > :first-child { margin-top: 0; }
.cc-aside-msg.is-assistant .cc-md > :last-child { margin-bottom: 0; }
.cc-aside-waiting { display: flex; align-items: center; gap: 7px; color: #9a7a4a; font-size: 10.5px; }
.cc-aside-error { display: flex; gap: 6px; padding: 7px 8px; border-radius: 7px; background: rgba(229, 72, 77, .08); color: #b42318; font-size: 10.5px; line-height: 1.5; }
.cc-aside-composer { flex: none; padding: 8px 10px 10px; border-top: 1px dashed rgba(217, 119, 6, .24); background: rgba(255, 255, 255, .4); }
.cc-aside-composer textarea { display: block; width: 100%; min-height: 54px; max-height: 140px; resize: none; border: 1px solid rgba(217, 119, 6, .22); border-radius: 9px; outline: none; background: rgba(255,255,255,.78); color: #3f2d13; font: inherit; font-size: 11.8px; line-height: 1.55; padding: 8px 9px; }
.cc-aside-composer textarea:focus { border-color: rgba(217, 119, 6, .55); box-shadow: 0 0 0 3px rgba(217, 119, 6, .08); }
.cc-aside-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 150px 0 0; }
.cc-aside-model { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #a37534; font-size: 9.5px; }
.cc-aside-model .cc-icon { color: #d97706; flex: none; }
.cc-aside-send { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border: 1px solid #9a5b08; border-radius: 7px; background: #9a5b08; color: #fff; font-size: 10.5px; font-weight: 650; }
.cc-aside-send:hover { background: #7c4a08; }
.cc-aside-send:disabled { opacity: .4; }
.cc-aside-send.is-stop { background: #b45309; border-color: #b45309; }

/* Canvas finder */
.cc-finder-layer { position: absolute; inset: 0; z-index: 105; display: flex; align-items: flex-start; justify-content: center; padding: 68px 18px 18px; background: color-mix(in oklab, #060a16 22%, transparent); backdrop-filter: blur(5px); animation: cc-fade .14s ease; }
.cc-finder { display: flex; flex-direction: column; width: min(660px, 100%); max-height: min(68vh, 620px); border: 1px solid var(--cc-border-strong); border-radius: 16px; background: rgba(255, 255, 255, .97); box-shadow: 0 32px 90px -28px rgba(3, 6, 18, .55), inset 0 1px 0 rgba(255,255,255,.7); overflow: hidden; animation: cc-pop .16s cubic-bezier(.2,.8,.2,1); }
.cc-finder-input { display: flex; align-items: center; gap: 9px; padding: 11px 14px; border-bottom: 1px solid var(--cc-border); color: var(--cc-accent); flex: none; }
.cc-finder-input input { flex: 1; min-width: 0; height: 28px; border: none; outline: none; background: transparent; color: var(--cc-text); font: inherit; font-size: 14px; }
.cc-finder-count { min-width: 22px; height: 18px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--cc-surface-2); color: var(--cc-muted); font-size: 9.5px; }
.cc-finder-results { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
.cc-finder-item { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; text-align: left; }
.cc-finder-item:hover, .cc-finder-item.is-active { border-color: color-mix(in oklab, var(--cc-accent) 22%, transparent); background: color-mix(in oklab, var(--cc-accent) 7%, transparent); }
.cc-finder-item-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cc-finder-item-top .cc-icon { color: var(--cc-accent); flex: none; }
.cc-finder-item-prompt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cc-text); font-size: 12px; font-weight: 600; }
.cc-finder-item-time { flex: none; color: var(--cc-muted); font-size: 9px; font-variant-numeric: tabular-nums; }
.cc-finder-item-answer { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cc-muted); font-size: 10.5px; padding-left: 18px; }
.cc-finder-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 140px; color: var(--cc-muted); font-size: 11.5px; }
.cc-finder-foot { display: flex; align-items: center; gap: 7px; padding: 7px 12px; border-top: 1px solid var(--cc-border); color: var(--cc-muted); font-size: 9.5px; flex: none; }
.cc-finder-foot kbd { padding: 1px 5px; border: 1px solid var(--cc-border); border-radius: 4px; background: var(--cc-surface-2); font-family: inherit; font-size: 9px; }

html[data-ds-theme-source="dark"] .cc-breadcrumb,
html[data-ds-theme-source="dark"] .cc-focus-chip { background: rgba(20, 23, 30, .78); }
html[data-ds-theme-source="dark"] .cc-selection-menu { background: rgba(41, 33, 22, .98); border-color: rgba(245, 158, 11, .28); }
html[data-ds-theme-source="dark"] .cc-selection-quote { color: #e8bb72; }
html[data-ds-theme-source="dark"] .cc-selection-action { background: rgba(255,255,255,.06); color: #f0c47b; border-color: rgba(245,158,11,.2); }
html[data-ds-theme-source="dark"] .cc-selection-action.is-primary { background: #b45309; color: #fff; }
html[data-ds-theme-source="dark"] .cc-aside-panel { background: linear-gradient(180deg, rgba(38, 31, 22, .98), rgba(30, 25, 18, .97)); border-color: rgba(245, 158, 11, .26); }
html[data-ds-theme-source="dark"] .cc-aside-quote { background: rgba(255,255,255,.04); }
html[data-ds-theme-source="dark"] .cc-aside-quote blockquote { color: #e8c99a; }
html[data-ds-theme-source="dark"] .cc-aside-msg.is-assistant .cc-md { color: #f0e2cd; }
html[data-ds-theme-source="dark"] .cc-aside-composer { background: rgba(255,255,255,.02); }
html[data-ds-theme-source="dark"] .cc-aside-composer textarea { background: rgba(255,255,255,.05); color: #f3e5cf; }
html[data-ds-theme-source="dark"] .cc-finder { background: rgba(22, 25, 32, .98); }
html[data-ds-theme-source="dark"] .cc-aside-empty strong { color: #f0c47b; }
html[data-ds-theme-source="dark"] .cc-node.cc-aside-card { background: linear-gradient(162deg, rgba(43, 35, 24, .98), rgba(35, 29, 21, .96)); border-color: rgba(245, 158, 11, .42); }
html[data-ds-theme-source="dark"] .cc-aside-card-head { background: rgba(56, 43, 26, .72); border-bottom-color: rgba(245, 158, 11, .26); }
html[data-ds-theme-source="dark"] .cc-aside-card-prompt { background: rgba(255,255,255,.025); border-bottom-color: rgba(245, 158, 11, .2); }
html[data-ds-theme-source="dark"] .cc-aside-card-quote-text { color: #e8c99a; }
html[data-ds-theme-source="dark"] .cc-aside-card-preview { color: #f0e2cd; }
html[data-ds-theme-source="dark"] .cc-aside-saved-tag,
html[data-ds-theme-source="dark"] .cc-aside-card-quote-label,
html[data-ds-theme-source="dark"] .cc-aside-card-thread-meta { color: #e8bb72; }
html[data-ds-theme-source="dark"] .cc-aside-card-foot { border-top-color: rgba(245, 158, 11, .2); }
html[data-ds-theme-source="dark"] .cc-aside-open { color: #f0c47b !important; background: rgba(245,158,11,.1) !important; border-color: rgba(245,158,11,.24) !important; }
html[data-ds-theme-source="dark"] .cc-aside-save { color: #f0c47b; border-color: rgba(245,158,11,.28); }

@keyframes cc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes cc-dash { to { stroke-dashoffset: -26; } }
@keyframes cc-scan { 0% { filter: hue-rotate(0deg); opacity: .75; } 50% { opacity: 1; } 100% { filter: hue-rotate(12deg); opacity: .75; } }
@keyframes cc-bounce { 0%, 100% { transform: translateY(0); opacity: .55; } 50% { transform: translateY(-3px); opacity: 1; } }
@keyframes cc-caret { 0%, 45% { opacity: 1; } 55%, 100% { opacity: .1; } }
@keyframes cc-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
@keyframes cc-spin { to { transform: rotate(360deg); } }
@keyframes cc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes cc-pop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes cc-menu-pop { from { opacity: 0; transform: translate(-50%, -94%) scale(.985); } to { opacity: 1; transform: translate(-50%, -100%); } }
@keyframes cc-menu-pop-below { from { opacity: 0; transform: translate(-50%, -6%) scale(.985); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes cc-rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

@media (max-width: 1180px) {
  .cc-brand-sub, .cc-board-count, .cc-save, .cc-help-btn { display: none; }
  .cc-primary-label { display: none; }
  .cc-primary { padding: 0 10px; }
  .cc-hero-chips { grid-template-columns: 1fr; }
}
@media (max-width: 820px) {
  .cc-minimap { display: none; }
  .cc-board-title { max-width: 130px; }
  .cc-chip-text { max-width: 110px; }
  .cc-hint { display: none; }
  .cc-dock { width: calc(100% - 24px); bottom: 12px; }
  .cc-hero { padding: 18px; }
  .cc-hero-sub { font-size: 12.5px; }
  .cc-breadcrumb { max-width: calc(100% - 92px); }
  .cc-breadcrumb-count { display: none; }
  .cc-focus-chip { display: none; }
  .cc-aside-panel { left: 10px; right: 10px; top: 60px; bottom: 84px; width: auto; }
  .cc-selection-actions { flex-wrap: wrap; }
  .cc-selection-action.is-icon { margin-left: 0; }
  .cc-export-formats, .cc-export-scopes { grid-template-columns: 1fr; }
  .cc-export-summary { display: none; }
}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx.slots) return
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-canvas-branch-chat',
              order: 5,
              label: () => L('画布分叉聊天', 'Branching Canvas'),
            },
            CanvasSidebarIcon
          )
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'dsh-canvas-branch-chat',
            },
            CanvasChatPage
          )
        )
      },
    }
  },
})

// Transitional shim for a browser tab whose boot graph was composed before
// the package was renamed from @local/dsh-canvas-chat. Fresh boots never see
// this id, so the shim is inert for new installs.
if (
  typeof window !== 'undefined' &&
  window.__DSH_BOOT__ &&
  Array.isArray(window.__DSH_BOOT__.entries) &&
  window.__DSH_BOOT__.entries.some((entry) => entry && entry.id === '@local/dsh-canvas-chat')
) {
  window.__ModuleLoader__.load({
    id: '@local/dsh-canvas-chat',
    factory() {
      return { inject: [], apply() {} }
    },
  })
}