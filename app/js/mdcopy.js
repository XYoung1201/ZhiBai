// Markdown 往返工具：把阅读器里的 DOM 片段还原成 Markdown 原文（含公式 TeX）、复制到剪贴板、读写 zip
const BLOCK = /^(P|DIV|SECTION|ARTICLE|LI|UL|OL|BLOCKQUOTE|PRE|TABLE|H[1-6]|HR|FIGURE|FIGCAPTION|DL|DD|DT)$/;

export function texOf(el) {
  const tex = el.dataset.tex;
  if (tex == null) return null;
  if (!el.classList.contains('math-block')) return `$${tex.trim()}$`;
  return el.tagName === 'SPAN' ? `$$${tex.trim()}$$` : `$$\n${tex.trim()}\n$$`;
}

// frag：Range.cloneContents() 的结果或任意元素。opts.images：收集用到的资源路径
export function fragmentToMarkdown(frag, opts = {}) {
  const ctx = { list: 0, ...opts };
  const md = frag.nodeType === 1 && frag.dataset?.tex != null ? convert(frag, ctx) : children(frag, ctx);
  return md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function children(node, ctx) { let out = ''; for (const c of node.childNodes) out += convert(c, ctx); return out; }
const wrapInline = (s, m) => { const t = s.trim(); return t ? s.replace(t, m + t + m) : s; };

function convert(n, ctx) {
  if (n.nodeType === 3) return ctx.pre ? n.data : n.data.replace(/[ \t]*\n[ \t]*/g, ' ');
  if (n.nodeType !== 1) return '';
  const tag = n.tagName;
  if (n.dataset?.tex != null) {
    const m = texOf(n), body = n.tagName === 'DIV' ? `\n\n${m}\n\n` : m;
    return n.querySelector('mark.zb-q') ? body.replace(m, `==${m}==`) : body;
  }
  if (tag === 'MATH' || tag === 'ANNOTATION' || tag === 'STYLE' || tag === 'SCRIPT') return '';
  const inner = () => children(n, ctx);
  switch (tag) {
    case 'MARK': return n.classList.contains('zb-q') ? wrapInline(inner(), '==') : inner();
    case 'B': case 'STRONG': return wrapInline(inner(), '**');
    case 'I': case 'EM': return wrapInline(inner(), '*');
    case 'DEL': case 'S': return wrapInline(inner(), '~~');
    case 'CODE': return n.parentElement?.tagName === 'PRE' ? inner() : '`' + n.textContent.replace(/`/g, '\\`') + '`';
    case 'PRE': return '\n\n```\n' + children(n, { ...ctx, pre: true }).replace(/\n$/, '') + '\n```\n\n';
    case 'A': { const t = inner(), href = n.getAttribute('href'); return href && t.trim() ? `[${t}](${href})` : t; }
    case 'IMG': {
      const src = n.dataset.zbSrc || n.getAttribute('src') || '';
      if (/^blob:/.test(src)) return '';
      if (n.dataset.zbSrc) ctx.images?.add(n.dataset.zbSrc);
      return `![${n.getAttribute('alt') || ''}](${src.replace(/ /g, '%20')})`;
    }
    case 'BR': return '  \n';
    case 'HR': return '\n\n---\n\n';
    case 'SUP': return `<sup>${inner()}</sup>`;
    case 'SUB': return `<sub>${inner()}</sub>`;
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return `\n\n${'#'.repeat(+tag[1])} ${inner().trim()}\n\n`;
    case 'BLOCKQUOTE': return '\n\n' + inner().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
    case 'UL': case 'OL': {
      let i = +n.getAttribute('start') || 1, out = '\n';
      for (const li of n.children) {
        if (li.tagName !== 'LI') continue;
        const marker = tag === 'OL' ? `${i++}. ` : '- ';
        let body = children(li, { ...ctx, list: ctx.list + 1 }).trim().replace(/^☑ /, '[x] ').replace(/^☐ /, '[ ] ');
        body = body.split('\n').map((l, k) => k ? ' '.repeat(marker.length) + l : l).join('\n');
        out += marker + body + '\n';
      }
      return ctx.list ? out : out + '\n';
    }
    case 'TABLE': {
      const rows = [...n.querySelectorAll('tr')].map(tr => [...tr.children].map(c => children(c, ctx).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const w = Math.max(...rows.map(r => r.length));
      const line = r => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
      return '\n\n' + [line(rows[0]), line(Array(w).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
    }
  }
  const s = inner();
  return BLOCK.test(tag) ? `\n\n${s.trim()}\n\n` : s;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

// ---------- zip ----------
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
export const mimeOf = name => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

export function normPath(p) {
  const out = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); }
  return out.join('/');
}
export const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';

// 读取 zip → Map(路径 → Uint8Array)；跳过 __MACOSX、隐藏文件与目录
export async function readZip(blob) {
  const { configure, ZipReader, BlobReader, BlobWriter } = await import('../vendor/foliate/vendor/zip.js');
  configure({ useWebWorkers: false });
  const reader = new ZipReader(new BlobReader(blob));
  const files = new Map();
  for (const e of await reader.getEntries()) {
    if (e.directory) continue;
    const name = normPath(e.filename);
    if (!name || name.startsWith('__MACOSX/') || name.split('/').some(s => s.startsWith('.'))) continue;
    files.set(name, new Uint8Array(await (await e.getData(new BlobWriter())).arrayBuffer()));
  }
  return files;
}

// 极简 zip 写入（仅存储不压缩，UTF-8 文件名）：笔记与图片体积小，够用
let crcTable;
function crc32(u8) {
  if (!crcTable) crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function makeZip(files) { // files: [[name, Uint8Array|string]]
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of files) {
    const nb = enc.encode(name), body = typeof data === 'string' ? enc.encode(data) : data, crc = crc32(body);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true);
    head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
    head.setUint32(18, body.length, true); head.setUint32(22, body.length, true); head.setUint16(26, nb.length, true); head.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true); ch.setUint32(24, body.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
    parts.push(head, nb, body); central.push(ch, nb);
    offset += 30 + nb.length + body.length;
  }
  const csize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

export function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
