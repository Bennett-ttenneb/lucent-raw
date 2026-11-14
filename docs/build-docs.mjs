// Makes HTML, PDF and Word (.docx) files from the Markdown guides in this folder.
// Run from the project root:  node docs/make-built-list.mjs && node docs/build-docs.mjs
// The PDF is printed by Microsoft Edge (already on Windows); the .docx is written here, with no extra software.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { deflateRawSync, crc32 } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const FILES = [
  { md: 'user-guide.md', title: 'Lucent Raw: User Guide' },
  { md: 'developer-guide.md', title: 'Lucent Raw: Developer Guide' },
  { md: 'whats-built.md', title: 'Lucent Raw: what is built and what is not' },
  { md: 'privacy-policy.md', title: 'Lucent Raw: Privacy Policy' },
  { md: 'terms-and-conditions.md', title: 'Lucent Raw: Terms and Conditions' },
]

// ---- Markdown (the small part of it these guides use) into blocks -------------------------------------------

/** blocks: {t:'h',n,text} {t:'p',text} {t:'quote',text} {t:'ul',items} {t:'ol',items} {t:'table',head,rows} {t:'code',text} {t:'hr'} */
function parse(md) {
  const lines = md.replace(/\r/g, '').split('\n')
  const out = []
  let i = 0
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) { i++; continue }
    if (l.startsWith('```')) {
      const body = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      out.push({ t: 'code', text: body.join('\n') })
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) { out.push({ t: 'h', n: h[1].length, text: h[2] }); i++; continue }
    if (/^---+\s*$/.test(l)) { out.push({ t: 'hr' }); i++; continue }
    if (l.startsWith('>')) {
      const body = []
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''))
      out.push({ t: 'quote', text: body.join(' ') })
      continue
    }
    if (l.trim().startsWith('|') && lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(l)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      out.push({ t: 'table', head, rows })
      continue
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let s = lines[i++].replace(/^\s*[-*]\s+/, '')
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) s += ' ' + lines[i++].trim()
        items.push(s)
      }
      out.push({ t: 'ul', items })
      continue
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        let s = lines[i++].replace(/^\s*\d+\.\s+/, '')
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) s += ' ' + lines[i++].trim()
        items.push(s)
      }
      out.push({ t: 'ol', items })
      continue
    }
    const body = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|---+\s*$)/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !(lines[i].trim().startsWith('|') && lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]))) body.push(lines[i++].trim())
    out.push({ t: 'p', text: body.join(' ') })
  }
  return out
}

/** inline pieces: {text, b, i, code} */
function inline(s) {
  const parts = []
  for (const tok of s.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/)) {
    if (!tok) continue
    if (tok.startsWith('`')) parts.push({ text: tok.slice(1, -1), code: true })
    else if (tok.startsWith('**')) for (const p of inline(tok.slice(2, -2))) parts.push({ ...p, b: true })
    else if (tok.startsWith('*') && tok.length > 2 && tok.endsWith('*')) for (const p of inline(tok.slice(1, -1))) parts.push({ ...p, i: true })
    else parts.push({ text: tok.replace(/\\\\/g, '\\') })
  }
  return parts
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---- HTML ---------------------------------------------------------------------------------------------------

const CSS = `
:root{--ink:#10151c;--muted:#4a5566;--accent:#4256e8;--line:#d5d9e3;--soft:#f3f4fb}
*{box-sizing:border-box}
body{font:11pt/1.55 "Segoe UI",Calibri,Arial,sans-serif;color:var(--ink);max-width:46rem;margin:2rem auto;padding:0 1.2rem}
h1{font-size:25pt;margin:0 0 .3em;color:#080d12;line-height:1.15}
h2{font-size:16pt;margin:1.8em 0 .4em;padding-bottom:.2em;border-bottom:2px solid var(--accent);color:#080d12;break-after:avoid}
h3{font-size:13pt;margin:1.4em 0 .3em;color:#1b2a6b;break-after:avoid}
h4{font-size:11pt;margin:1.1em 0 .2em;color:#1b2a6b;break-after:avoid}
p{margin:.5em 0}
ul,ol{margin:.4em 0 .6em 1.3em;padding:0}
li{margin:.2em 0}
code{font:10pt Consolas,"Courier New",monospace;background:var(--soft);padding:.05em .3em;border-radius:4px}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:.7em .9em;overflow:auto;break-inside:avoid}
pre code{background:none;padding:0;font-size:9.5pt}
blockquote{margin:.8em 0;padding:.5em 1em;border-left:4px solid var(--accent);background:var(--soft);border-radius:0 8px 8px 0}
table{border-collapse:collapse;width:100%;margin:.7em 0;font-size:10pt}
th,td{border:1px solid var(--line);padding:.35em .55em;text-align:left;vertical-align:top}
th{background:var(--soft)}
tr{break-inside:avoid}
hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}
@media print{body{margin:0;max-width:none;font-size:10.5pt}h2{margin-top:1.4em}a{color:inherit}}
@page{size:A4;margin:18mm 16mm}
`

function inlineHtml(s) {
  return inline(s).map((p) => { let t = esc(p.text); if (p.code) t = `<code>${t}</code>`; if (p.b) t = `<strong>${t}</strong>`; if (p.i) t = `<em>${t}</em>`; return t }).join('')
}

function toHtml(blocks, title) {
  let body = ''
  let first = true
  for (const b of blocks) {
    if (b.t === 'h') { body += `<h${b.n}>${inlineHtml(b.text)}</h${b.n}>\n`; first = false }
    else if (b.t === 'p') body += `<p>${inlineHtml(b.text)}</p>\n`
    else if (b.t === 'quote') body += `<blockquote>${inlineHtml(b.text)}</blockquote>\n`
    else if (b.t === 'ul') body += `<ul>${b.items.map((x) => `<li>${inlineHtml(x)}</li>`).join('')}</ul>\n`
    else if (b.t === 'ol') body += `<ol>${b.items.map((x) => `<li>${inlineHtml(x)}</li>`).join('')}</ol>\n`
    else if (b.t === 'code') body += `<pre><code>${esc(b.text)}</code></pre>\n`
    else if (b.t === 'hr') body += '<hr>\n'
    else if (b.t === 'table') body += `<table><thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>\n`
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>\n${body}</body></html>\n`
}

// ---- Word (.docx): a zip of a few XML files, written by hand --------------------------------------------------

const x = (s) => esc(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

function runs(s, extra = '') {
  return inline(s).map((p) => {
    const rpr = `${p.b ? '<w:b/>' : ''}${p.i ? '<w:i/>' : ''}${p.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/><w:shd w:val="clear" w:color="auto" w:fill="F0F1FA"/>' : ''}${extra}`
    return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(p.text)}</w:t></w:r>`
  }).join('')
}

const para = (inner, style, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${inner}</w:p>`

function toDocx(blocks, title) {
  const W = 9360 // text width in twentieths of a point (6.5 inches)
  let body = ''
  let sawTitle = false
  for (const b of blocks) {
    if (b.t === 'h') {
      const style = b.n === 1 && !sawTitle ? 'Title' : `Heading${Math.min(b.n, 3)}`
      if (b.n === 1) sawTitle = true
      body += para(runs(b.text), style)
    } else if (b.t === 'p') body += para(runs(b.text), '')
    else if (b.t === 'quote') body += para(runs(b.text), 'Quote')
    else if (b.t === 'ul') for (const it of b.items) body += para(`<w:r><w:t xml:space="preserve">\u2022\t</w:t></w:r>${runs(it)}`, '', '<w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs><w:ind w:left="420" w:hanging="300"/><w:spacing w:after="60"/>')
    else if (b.t === 'ol') b.items.forEach((it, n) => (body += para(`<w:r><w:t xml:space="preserve">${n + 1}.\t</w:t></w:r>${runs(it)}`, '', '<w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs><w:ind w:left="420" w:hanging="360"/><w:spacing w:after="60"/>')))
    else if (b.t === 'code') for (const l of b.text.split('\n')) body += para(`<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${x(l)}</w:t></w:r>`, '', '<w:shd w:val="clear" w:color="auto" w:fill="F0F1FA"/><w:spacing w:after="0"/>')
    else if (b.t === 'hr') body += para('', '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D5D9E3"/></w:pBdr>')
    else if (b.t === 'table') {
      const n = b.head.length
      // widths: wider for the last column when there is a long text column
      const longest = b.head.map((_, c) => Math.max(...[b.head, ...b.rows].map((r) => (r[c] ?? '').length)))
      const total = longest.reduce((a, v) => a + Math.max(8, Math.min(v, 90)), 0)
      let widths = longest.map((v) => Math.max(900, Math.floor((W * Math.max(8, Math.min(v, 90))) / total)))
      const drift = W - widths.reduce((a, v) => a + v, 0)
      widths[widths.length - 1] += drift
      const cell = (txt, w, head) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F1FA"/>' : ''}</w:tcPr>${para(runs(txt, head ? '<w:b/>' : ''), '', '<w:spacing w:after="40"/>')}</w:tc>`
      const row = (r, head) => `<w:tr><w:trPr><w:cantSplit/>${head ? '<w:tblHeader/>' : ''}</w:trPr>${Array.from({ length: n }, (_, c) => cell(r[c] ?? '', widths[c], head)).join('')}</w:tr>`
      body += `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="C9CEDC"/>`).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${row(b.head, true)}${b.rows.map((r) => row(r, false)).join('')}</w:tbl>${para('', '', '<w:spacing w:after="80"/>')}`
    }
  }
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const heading = (id, name, size, color, before, after) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1 || 0}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr></w:style>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:b/><w:color w:val="080D12"/><w:sz w:val="52"/></w:rPr></w:style>${heading('Heading1', 'heading 1', 36, '080D12', 360, 120)}${heading('Heading2', 'heading 2', 32, '080D12', 360, 100)}${heading('Heading3', 'heading 3', 26, '1B2A6B', 240, 80)}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="4256E8"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F0F1FA"/><w:ind w:left="240"/></w:pPr><w:rPr><w:i/></w:rPr></w:style></w:styles>`
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1273" w:bottom="1134" w:left="1273" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/document.xml': doc,
    'word/styles.xml': styles,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>Lucent Raw</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
  }
  return zip(files)
}

/** A zip file from {name: text}, deflated, written by hand (this is all a .docx is). */
function zip(files) {
  const chunks = []
  const central = []
  let offset = 0
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
  const now = new Date()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8')
    const packed = deflateRawSync(data)
    const nameB = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(time), u16(date), u32(crc), u32(packed.length), u32(data.length), u16(nameB.length), u16(0), nameB])
    chunks.push(local, packed)
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(time), u16(date), u32(crc), u32(packed.length), u32(data.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB]))
    offset += local.length + packed.length
  }
  const cd = Buffer.concat(central)
  return Buffer.concat([...chunks, cd, u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(offset), u16(0)])
}

// ---- run ----------------------------------------------------------------------------------------------------

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const outDir = join(dir, 'out')
mkdirSync(outDir, { recursive: true })
for (const f of FILES) {
  const blocks = parse(readFileSync(join(dir, f.md), 'utf8'))
  const base = f.md.replace(/\.md$/, '')
  writeFileSync(join(outDir, base + '.html'), toHtml(blocks, f.title))
  writeFileSync(join(outDir, base + '.docx'), toDocx(blocks, f.title))
  if (EDGE) {
    try {
      execFileSync(EDGE, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${join(outDir, base + '.pdf')}`, pathToFileURL(join(outDir, base + '.html')).href], { stdio: 'ignore', timeout: 120000 })
    } catch (e) {
      console.log('PDF failed for', base, e.message)
    }
  }
  console.log('made', base, blocks.length, 'blocks')
}
if (process.argv[2]) {
  mkdirSync(process.argv[2], { recursive: true })
  for (const f of FILES) for (const e of ['docx', 'pdf', 'html']) { const n = f.md.replace(/\.md$/, '.' + e); if (existsSync(join(outDir, n))) copyFileSync(join(outDir, n), join(process.argv[2], n)) }
  console.log('copied to', process.argv[2])
}
