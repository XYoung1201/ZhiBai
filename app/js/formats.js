// 各种格式 → 统一的「流式书」模型：{ kind:'flow', title, author, lang, sections:[{title, load()}], toc:[{label, level, s, key}], resolveLink, getCover }
// PDF 不在此处，由 pdfdoc.js 负责。
import DOMPurify from '../vendor/purify.es.mjs';

export const EXT_FORMAT = {
  pdf: 'pdf', epub: 'epub', mobi: 'mobi', azw: 'mobi', azw3: 'mobi', kf8: 'mobi', prc: 'mobi', fb2: 'fb2', fbz: 'fb2', 'fb2.zip': 'fb2',
  txt: 'txt', text: 'txt', md: 'md', markdown: 'md', html: 'html', htm: 'html', xhtml: 'html', docx: 'docx', doc: 'doc', cbz: 'cbz',
};
export const ACCEPT = Object.keys(EXT_FORMAT).map(e => '.' + e).join(',');
export function formatOf(name = '') {
  const n = name.toLowerCase();
  if (n.endsWith('.fb2.zip')) return 'fb2';
  return EXT_FORMAT[n.split('.').pop()] || null;
}
export function metaFromName(name) {
  let t = name.replace(/\.[^.]+$/, '').replace(/\.fb2$/i, '');
  t = t.replace(/\s*\((?:Z-Library|z-lib\.org)\)/gi, '').replace(/_\d{6,}$/, '').replace(/^[\[【](.+?)[\]】]/, '$1').trim();
  let author = '';
  const m = /^(.+?)\s*[-—_]\s*([^-—_]{2,12})$/.exec(t) || /^(.+?)[（(]([^()（）]{2,16}?)(?:\s*[著编译]+)?[)）]$/.exec(t);
  if (m && !/\d/.test(m[2])) { t = m[1].trim(); author = m[2].trim(); }
  return { title: t || name, author };
}

// ---------- 清洗 ----------
const KEEP_STYLE = new Set(['text-align', 'font-style', 'font-weight', 'text-decoration', 'vertical-align', 'font-variant']);
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'style') {
    const keep = data.attrValue.split(';').map(d => d.split(':').map(s => s?.trim().toLowerCase())).filter(([p, v]) => v && KEEP_STYLE.has(p) && !/url|expression/.test(v));
    data.attrValue = keep.map(([p, v]) => `${p}:${v}`).join(';');
    if (!keep.length) data.keepAttr = false;
  } else if (data.attrName === 'class' || (node.tagName === 'IMG' && (data.attrName === 'width' || data.attrName === 'height'))) data.keepAttr = false;
});
export function sanitize(html) {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['epub:type', 'data-zb-anchor', 'xlink:href', 'viewBox', 'preserveAspectRatio'],
    FORBID_TAGS: ['style', 'link', 'script', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed', 'meta', 'title', 'base'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|blob|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
}

// ---------- 文本解码 ----------
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  const dec = (enc, b = u8, fatal = false) => new TextDecoder(enc, { fatal }).decode(b);
  if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return dec('utf-8', u8.subarray(3));
  if (u8[0] === 0xFF && u8[1] === 0xFE) return dec('utf-16le', u8.subarray(2));
  if (u8[0] === 0xFE && u8[1] === 0xFF) return dec('utf-16be', u8.subarray(2));
  let zo = 0, ze = 0; const n = Math.min(u8.length, 4096);
  for (let i = 0; i < n; i++) if (!u8[i]) (i % 2 ? zo++ : ze++);
  if (zo > n / 8) return dec('utf-16le');
  if (ze > n / 8) return dec('utf-16be');
  try { return dec('utf-8', u8, true); } catch {}
  const gb = dec('gb18030');
  // 粗判繁体 Big5：GB 解码后出现大量私用区/罕见字时改用 Big5
  const odd = (gb.slice(0, 20000).match(new RegExp('[\ue000-\uf8ff\u3400-\u4dbf\u9fa6-\u9fff]', 'g')) || []).length;
  if (odd > 50) { try { return dec('big5'); } catch {} }
  return gb;
}

// ---------- 纯文本 → 章节 ----------
const NUM = '0-9零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟';
const HEAD_RE = new RegExp(`^(?:第[${NUM}]+[章节回卷部篇集幕讲话](?:[\\s:：、.．·—-].{0,40}|$)|卷[${NUM}]+(?:\\s.{0,30})?$|(?:序章?|楔子|引子|前言|引言|后记|尾声|番外.{0,20}|自序|代序|跋|附录.{0,20}|序言|导言|结语)(?:[\\s:：·].{0,30})?$|(?:chapter|part|book)\\s+[0-9ivxlc]+\\b.{0,50}$)`, 'i');
const isVolume = s => /^(?:第[^章节回]+[卷部篇集]|卷[^\s]+|part\s|book\s)/i.test(s);
const CNN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) { let t = 0, c = 0; for (const ch of s) { if (ch in CNN) c = CNN[ch]; else if (ch === '十') { t += (c || 1) * 10; c = 0; } else if (ch === '百') { t += (c || 1) * 100; c = 0; } } return t + c; }
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export function plainToBook(text, title) {
  text = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  let lines = text.split('\n');
  // 硬换行合并：段落以空行分隔、且块内行不缩进时
  const blank = lines.filter(l => !l.trim()).length;
  if (blank > lines.length * .25) {
    const blocks = text.split(/\n\s*\n/);
    // 只有当块内各行（除末行）普遍接近满行、且不以句读收尾时，才视为硬换行
    const lens = lines.map(l => l.trim().length).filter(n => n > 0).sort((a, b) => a - b);
    const full = lens[Math.floor(lens.length * .9)] || 0;
    let inner = 0, wrapped = 0;
    for (const b of blocks) {
      const ls = b.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of ls.slice(0, -1)) { inner++; if (l.length >= full * .7 && !/[。！？!?”」』…：:；;]$/.test(l)) wrapped++; }
    }
    if (inner > 20 && wrapped > inner * .6) {
      lines = blocks.flatMap(b => {
        const out = [];
        for (const l of b.split('\n').map(x => x.trim()).filter(Boolean)) {
          const prev = out[out.length - 1];
          if (prev == null || HEAD_RE.test(prev) || HEAD_RE.test(l) || /[。！？!?”」』…]$/.test(prev) || prev.length < full * .7) out.push(l);
          else out[out.length - 1] = /[　-鿿＀-￯]$/.test(prev) || /^[　-鿿＀-￯]/.test(l) ? prev + l : prev + ' ' + l;
        }
        return out;
      });
    }
  }
  const paras = lines.map(l => l.replace(/^[\s　]+|[\s　]+$/g, '')).filter(Boolean);
  const heads = [];
  paras.forEach((p, i) => { if (p.length <= 46 && HEAD_RE.test(p) && !/[。！？；，]$/.test(p)) heads.push(i); });
  // 「一、」「1.」式弱标题：须按序递增且彼此相隔足够远，避免把正文列表当成章节
  if (heads.length < 3) {
    const WEAK = /^([一二三四五六七八九十百]+|\d{1,3})\s*[、.．]\s*(\S.{0,30})$/;
    let expect = 1, last = -99;
    paras.forEach((p, i) => {
      const m = WEAK.exec(p);
      if (!m || /[。！？；，]$/.test(p)) return;
      const n = /\d/.test(m[1]) ? +m[1] : cnNum(m[1]);
      if (n === 1 && i - last > 12 && expect !== 1) expect = 1;
      if (n === expect && (i - last > 12 || expect === 1)) { heads.push(i); last = i; expect++; }
    });
    heads.sort((a, b) => a - b);
  }
  const useHeads = heads.length >= 3 && heads.length <= paras.length / 1.5;
  const sections = [], toc = [];
  const push = (title, body, level = 1) => {
    const s = sections.length;
    const html = !body.length && title ? `<div class="titlepage part"><h1>${esc(title)}</h1></div>` : (title ? `<h2 class="chap">${esc(title)}</h2>` : '') + body.map(p => `<p>${esc(p)}</p>`).join('');
    sections.push({ title, html });
    if (title) toc.push({ label: title, level, s });
  };
  const chunk = (title, body, level) => {
    // 超长章节切片，单片约 1.6 万字
    let part = [], n = 0, k = 0;
    for (const p of body) {
      part.push(p); n += p.length;
      if (n > 16000) { push(k++ ? `${title || '正文'}（续 ${k}）` : title, part, level); part = []; n = 0; }
    }
    if (part.length || !k) push(k ? `${title || '正文'}（续 ${k}）` : title, part, level);
  };
  if (useHeads) {
    const pre = paras.slice(0, heads[0]);
    if (pre.length && pre.join('').length < 400) {
      // 短小的卷首（书名、作者、译者）排成扉页
      sections.push({ title: '', html: `<div class="titlepage"><h1>${esc(pre[0])}</h1>${pre.slice(1).map(p => `<p>${esc(p)}</p>`).join('')}</div>` });
    } else if (pre.length) chunk('', pre, 1);
    heads.forEach((h, j) => {
      const t = paras[h], body = paras.slice(h + 1, heads[j + 1] ?? paras.length);
      if (isVolume(t) && body.length < 3) { push(t, body, 1); return; }
      chunk(t, body, heads.some(x => isVolume(paras[x])) && !isVolume(t) ? 2 : 1);
    });
  } else {
    let part = [], n = 0, k = 1;
    for (const p of paras) { part.push(p); n += p.length; if (n > 9000) { push(`第 ${k++} 节`, part); part = []; n = 0; } }
    if (part.length || !sections.length) push(sections.length ? `第 ${k} 节` : '', part);
  }
  return htmlBook(sections, toc, { title });
}

// ---------- HTML → 章节（按标题切分） ----------
export function htmlToBook(html, meta = {}, prepare) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${sanitize(html)}</body>`, 'text/html');
  prepare?.(doc.body);
  let root = doc.body;
  while (root.children.length === 1 && !root.firstElementChild.classList.contains('math-block') && /^(DIV|SECTION|ARTICLE|MAIN)$/.test(root.firstElementChild.tagName)) root = root.firstElementChild;
  let level = 0;
  for (const n of [1, 2, 3]) if (root.querySelectorAll(`:scope > h${n}`).length >= 2) { level = n; break; }
  const sections = [], toc = [];
  let cur = [], curTitle = '', hid = 0, len = 0;
  const flush = () => {
    if (!cur.length && !curTitle) return;
    const s = sections.length;
    const wrap = doc.createElement('div'); cur.forEach(n => wrap.append(n));
    for (const sub of wrap.querySelectorAll(`h${level + 1}`)) { const k = 'zb-h' + hid++; sub.setAttribute('data-zb-anchor', k); toc.push({ label: sub.textContent.trim().slice(0, 80), level: 2, s, key: k }); }
    sections.push({ title: curTitle, html: wrap.innerHTML });
    cur = []; curTitle = ''; len = 0;
  };
  for (const node of [...root.childNodes]) {
    const isHead = level && node.nodeType === 1 && node.tagName === 'H' + level;
    if (isHead || len > 60000) {
      flush();
      if (isHead) { curTitle = node.textContent.trim().slice(0, 80); toc.push({ label: curTitle, level: 1, s: sections.length }); }
    }
    cur.push(node); len += node.textContent.length;
  }
  flush();
  if (!sections.length) sections.push({ title: '', html: '' });
  // 把二级目录项排到其所属一级目录之后
  toc.sort((a, b) => a.s - b.s || a.level - b.level);
  return htmlBook(sections, toc, meta);
}

function htmlBook(sections, toc, meta) {
  return {
    kind: 'flow', title: meta.title || '', author: meta.author || '', lang: meta.lang,
    sections: sections.map(s => ({ title: s.title, load: async () => s.html })),
    toc, resolveLink: async href => (href?.startsWith('#') ? findLocalAnchor(sections, href.slice(1)) : null),
    getCover: async () => null, destroy() {},
  };
}
function findLocalAnchor(sections, id) {
  const i = sections.findIndex(s => s.html.includes(`id="${id}"`) || s.html.includes(`name="${id}"`));
  return i < 0 ? null : { s: i, selector: `[id="${CSS.escape(id)}"],[name="${CSS.escape(id)}"]` };
}

// ---------- 旧版 Word .doc（OLE 复合文档 + 片段表） ----------
const scripts = {};
export function loadScript(src) {
  return scripts[src] || (scripts[src] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('无法加载 ' + src)); document.head.append(s);
  }));
}
async function docToText(buf) {
  await loadScript('vendor/cfb.min.js');
  const cfb = window.CFB.read(new Uint8Array(buf), { type: 'array' });
  const get = n => { const e = window.CFB.find(cfb, n); return e ? Uint8Array.from(e.content) : null; };
  const w = get('WordDocument'); if (!w) throw new Error('不是有效的 Word 文档');
  const u16 = (b, o) => b[o] | (b[o + 1] << 8), u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (u16(w, 0x0A) & 0x0100) throw new Error('文档已加密，无法读取');
  const table = get((u16(w, 0x0A) & 0x0200) ? '1Table' : '0Table');
  const ccpText = u32(w, 0x4C), fcClx = u32(w, 0x1A2), lcbClx = u32(w, 0x1A6);
  let out = '';
  if (table && lcbClx) {
    let pos = fcClx;
    while (table[pos] === 0x01) pos += 3 + u16(table, pos + 1);
    if (table[pos] !== 0x02) throw new Error('无法解析文档结构');
    const lcb = u32(table, pos + 1); pos += 5;
    const n = (lcb - 4) / 12;
    const cps = Array.from({ length: n + 1 }, (_, i) => u32(table, pos + i * 4));
    const base = pos + (n + 1) * 4;
    const d16 = new TextDecoder('utf-16le'), d8 = new TextDecoder('windows-1252');
    for (let i = 0; i < n && cps[i] < ccpText; i++) {
      const raw = u32(table, base + i * 8 + 2), len = Math.min(cps[i + 1], ccpText) - cps[i];
      out += raw & 0x40000000 ? d8.decode(w.subarray((raw & 0x3FFFFFFF) / 2, (raw & 0x3FFFFFFF) / 2 + len)) : d16.decode(w.subarray(raw, raw + len * 2));
    }
  } else { // Word 6/95：文本连续存放
    const fcMin = u32(w, 0x18), fcMac = u32(w, 0x1C);
    out = new TextDecoder('gb18030').decode(w.subarray(fcMin, fcMac));
  }
  // 去掉域代码（\x13 代码 \x14 结果 \x15）与对象占位符
  out = out.replace(/\x13[^\x13\x14\x15]*\x14/g, '').replace(/\x13[^\x15]*\x15/g, '').replace(/[\x14\x15\x01\x08]/g, '');
  return out.replace(/\x07/g, '\t').replace(/[\x0B\x0C]/g, '\n').replace(/\r/g, '\n');
}

// ---------- 交给 foliate-js 的格式（EPUB / MOBI / AZW3 / FB2 / CBZ） ----------
const str = x => typeof x === 'string' ? x : Array.isArray(x) ? x.map(str).filter(Boolean).join('、') : x?.name ? str(x.name) : x && typeof x === 'object' ? str(Object.values(x)[0]) : '';
async function makeFoliate(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const name = (file.name || '').toLowerCase();
  if (isZip) {
    const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } = await import('../vendor/foliate/vendor/zip.js');
    configure({ useWebWorkers: false });
    const reader = new ZipReader(new BlobReader(file));
    const entries = await reader.getEntries();
    const map = new Map(entries.map(e => [e.filename, e]));
    const load = f => (n, ...a) => map.has(n) ? f(map.get(n), ...a) : null;
    const loader = { entries, loadText: load(e => e.getData(new TextWriter())), loadBlob: load((e, t) => e.getData(new BlobWriter(t))), getSize: n => map.get(n)?.uncompressedSize ?? 0 };
    if (name.endsWith('.cbz')) { const { makeComicBook } = await import('../vendor/foliate/comic-book.js'); return makeComicBook(loader, file); }
    if (name.endsWith('.fbz') || name.endsWith('.fb2.zip')) {
      const { makeFB2 } = await import('../vendor/foliate/fb2.js');
      const e = entries.find(e => e.filename.endsWith('.fb2')) ?? entries[0];
      return makeFB2(await loader.loadBlob(e.filename));
    }
    const { EPUB } = await import('../vendor/foliate/epub.js');
    return new EPUB(loader).init();
  }
  const { isMOBI, MOBI } = await import('../vendor/foliate/mobi.js');
  if (await isMOBI(file)) { const fflate = await import('../vendor/foliate/vendor/fflate.js'); return new MOBI({ unzlib: fflate.unzlibSync }).open(file); }
  const { makeFB2 } = await import('../vendor/foliate/fb2.js');
  return makeFB2(file);
}
function parseDoc(text) {
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.querySelector('parsererror') || !doc.body) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}
function textOffsetOf(root, el) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement?.closest('style,script') ? 2 : 1 });
  let off = 0, n;
  while ((n = w.nextNode())) { if (el === n || el.contains?.(n) || (el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) return off; off += n.data.length; }
  return off;
}

async function foliateToBook(file) {
  const fb = await makeFoliate(file);
  const md = fb.metadata || {};
  const tocFlat = [];
  const walk = (items, level) => { for (const it of items || []) { tocFlat.push({ label: (it.label || '').trim(), href: it.href, level }); walk(it.subitems, level + 1); } };
  walk(fb.toc, 1);
  const toc = [];
  let k = 0;
  for (const t of tocFlat) {
    try {
      const r = await fb.resolveHref(t.href);
      if (!r || r.index == null || r.index < 0) continue;
      toc.push({ label: t.label || '—', level: Math.min(t.level, 3), s: r.index, key: 'zb-t' + k++, anchorFn: r.anchor });
    } catch {}
  }
  const bySection = new Map();
  for (const t of toc) (bySection.get(t.s) || bySection.set(t.s, []).get(t.s)).push(t);
  const cache = new Map();
  const sections = fb.sections.map((s, i) => ({
    title: '',
    linear: s.linear !== 'no',
    load: () => cache.get(i) || cache.set(i, (async () => {
      const url = await s.load();
      const doc = parseDoc(await (await fetch(url)).text());
      for (const t of bySection.get(i) || []) {
        try { const el = typeof t.anchorFn === 'function' ? t.anchorFn(doc) : null; if (el?.setAttribute) el.setAttribute('data-zb-anchor', t.key); } catch {}
      }
      return sanitize(doc.body ? doc.body.innerHTML : doc.documentElement.outerHTML);
    })()).get(i),
  }));
  for (const t of toc) if (t.level === 1 && !sections[t.s].title) sections[t.s].title = t.label;
  return {
    kind: 'flow',
    title: str(md.title), author: str(md.author), lang: str(md.language),
    dir: fb.dir, fixed: fb.rendition?.layout === 'pre-paginated',
    sections, toc,
    async resolveLink(href, from) {
      try {
        const full = fb.sections[from]?.resolveHref ? fb.sections[from].resolveHref(href) : href;
        const r = await fb.resolveHref(full);
        if (!r || r.index == null || r.index < 0) return null;
        if (typeof r.anchor !== 'function') return { s: r.index, offset: 0 };
        const raw = await fb.sections[r.index].createDocument();
        const el = r.anchor(raw);
        if (!el || typeof el === 'number') return { s: r.index, offset: 0 };
        return { s: r.index, offset: textOffsetOf(raw.body || raw.documentElement, el), text: el.textContent?.trim().slice(0, 1200) };
      } catch { return null; }
    },
    getCover: async () => { try { return await fb.getCover?.(); } catch { return null; } },
    destroy() { try { fb.destroy?.(); } catch {} },
  };
}

// ---------- 入口 ----------
export async function openFlowBook(blob, { name = '', format, title, author } = {}) {
  format = format || formatOf(name);
  const fallback = { title: title || metaFromName(name).title, author: author || '' };
  let book;
  switch (format) {
    case 'txt': book = plainToBook(decodeText(await blob.arrayBuffer()), fallback.title); break;
    case 'doc': book = plainToBook(await docToText(await blob.arrayBuffer()), fallback.title); break;
    case 'md': {
      const { markdownToBook } = await import('./markdown.js');
      book = markdownToBook(decodeText(await blob.arrayBuffer()), fallback); break;
    }
    case 'html': book = htmlToBook(decodeText(await blob.arrayBuffer()), fallback); break;
    case 'docx': {
      await loadScript('vendor/mammoth.browser.min.js');
      const r = await window.mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      book = htmlToBook(r.value, fallback); break;
    }
    case 'epub': case 'mobi': case 'fb2': case 'cbz': {
      const f = blob instanceof File ? blob : new File([blob], name || 'book.' + format);
      book = await foliateToBook(f); break;
    }
    default: throw new Error('暂不支持这种格式');
  }
  book.title = book.title || fallback.title;
  book.author = book.author || fallback.author;
  book.format = format;
  return book;
}

// 导入时快速读取元数据（不完整解析正文）
export async function peekMeta(file) {
  const format = formatOf(file.name);
  const base = metaFromName(file.name);
  if (['epub', 'mobi', 'fb2'].includes(format)) {
    try {
      const b = await foliateToBook(file);
      const cover = await b.getCover();
      const r = { format, title: b.title || base.title, author: b.author || base.author, cover };
      b.destroy(); return r;
    } catch {}
  }
  return { format, ...base };
}
