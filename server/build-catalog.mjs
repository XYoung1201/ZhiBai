// 扫描书库目录 → data/catalog.json；PDF 用 poppler 取页数与封面。增量：未变化的文件不重复处理。
// 每本书记下整个文件的 MD5（上传去重用）和书中第一段正文（书籍详情里的「摘要」）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BOOKS = process.env.BOOKS_DIR || path.join(ROOT, 'books');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const COVERS = path.join(DATA, 'covers');
const CACHE_FILE = path.join(DATA, 'scan-cache.json');
const META = await readJSON(path.join(ROOT, 'meta.json'), { categories: [], series: {}, books: {} });
const EXT = new Set(['pdf', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'docx', 'doc', 'cbz', 'zip']);
const FORMAT = { azw: 'mobi', azw3: 'mobi', markdown: 'md', htm: 'html', xhtml: 'html', fbz: 'fb2', zip: 'md' };

async function readJSON(f, d) { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return d; } }
const has = async cmd => run('sh', ['-c', `command -v ${cmd}`]).then(() => true, () => false);

async function* walk(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function contentId(file, size) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 262144));
    await fh.read(buf, 0, buf.length, 0);
    return crypto.createHash('sha1').update(String(size)).update(buf).digest('hex').slice(0, 16);
  } finally { await fh.close(); }
}

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  if (/^\d+$/.test(s)) return +s;
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN) cur = CN[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
  }
  return total + cur;
}
function guessVolume(name) {
  let m = /vol\.?\s*0*(\d+)/i.exec(name) || /第\s*([0-9一二三四五六七八九十百零〇两]+)\s*[部卷册集]/.exec(name) || /[（(]\s*([上中下])\s*[)）]/.exec(name);
  if (!m) return null;
  return { 上: 1, 中: 2, 下: 3 }[m[1]] ?? cnNum(m[1]);
}
function cleanTitle(name) {
  return name
    .replace(/\s*\((?:Z-Library|z-lib\.org|zlibrary|[^)]*\.pdf)\)\s*/gi, ' ')
    .replace(/\.(pdf|epub|mobi|azw3?)$/i, '')
    .replace(/_\d{6,}$/, '')
    .replace(/^[\[【](.+)[\]】]$/, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function pdfInfo(file) {
  try {
    const { stdout } = await run('pdfinfo', ['-enc', 'UTF-8', file], { maxBuffer: 1 << 20, timeout: 60e3 });
    const get = k => (new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(stdout) || [])[1]?.trim() || '';
    return { pages: +get('Pages') || null, title: get('Title'), author: get('Author'), w: parseFloat(get('Page size')) || null, h: +(/x\s*([\d.]+)/.exec(get('Page size')) || [])[1] || null };
  } catch { return {}; }
}
// 一页是否完全空白（没有任何墨迹）。只有这样的首页才跳过；浅色封面、只有书名的扉页照样当封面。
// 旧做法把页面缩到 48px 再数「暗像素占比 > 2%」，浅色或纯文字封面会被误判为空白而跳到第 2、3 页，甚至没有封面。
async function pageBlank(file, page) {
  const probe = path.join(DATA, '.probe-' + process.pid);
  try {
    await run('pdftoppm', ['-gray', '-scale-to', '160', '-f', String(page), '-l', String(page), '-singlefile', file, probe], { timeout: 60e3 });
    const buf = await fsp.readFile(probe + '.pgm');
    const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 40).toString('latin1'));
    if (!m) return false;
    let ink = 0; for (const v of buf.subarray(m[0].length)) if (v < 200) ink++;
    return ink < 12;
  } catch { return false; } finally { await fsp.rm(probe + '.pgm', { force: true }); }
}
async function pdfCover(file, id, pages = 1) {
  const out = path.join(COVERS, id);
  const last = Math.min(3, pages || 1);
  let page = 0;
  for (let p = 1; p <= last && !page; p++) if (!(await pageBlank(file, p))) page = p;
  if (!page) return false;
  try {
    await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=84,progressive=y', '-scale-to-x', '480', '-scale-to-y', '-1', '-f', String(page), '-l', String(page), '-singlefile', file, out], { timeout: 120e3 });
    return fs.existsSync(out + '.jpg');
  } catch (e) { console.warn('cover failed', file, e.message); return false; }
}

// ---------- EPUB / MOBI / AZW3 / FB2 / CBZ 封面（零依赖） ----------
async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}
const isImage = b => b && b.length > 200 && (
  (b[0] === 0xFF && b[1] === 0xD8) || b.subarray(0, 4).toString('latin1') === '\x89PNG' ||
  b.subarray(0, 3).toString('latin1') === 'GIF' || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'));

// 最小 ZIP 读取：中央目录 + stored / deflate
async function openZip(file) {
  const fh = await fsp.open(file, 'r');
  const { size } = await fh.stat();
  const tail = await readAt(fh, Math.max(0, size - 65557), Math.min(size, 65557));
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) { await fh.close(); return null; }
  const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  const cd = await readAt(fh, cdOff, cdSize);
  const entries = new Map();
  for (let p = 0, k = 0; k < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; k++) {
    const nameLen = cd.readUInt16LE(p + 28), extra = cd.readUInt16LE(p + 30), comment = cd.readUInt16LE(p + 32);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), off: cd.readUInt32LE(p + 42) });
    p += 46 + nameLen + extra + comment;
  }
  return {
    names: [...entries.keys()],
    has: n => entries.has(n),
    async read(name, max = 30 << 20) {
      const en = entries.get(name);
      if (!en || en.usize > max || en.csize > max) return null;
      const lh = await readAt(fh, en.off, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) return null;
      const data = await readAt(fh, en.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), en.csize);
      if (en.method === 0) return data;
      if (en.method === 8) return zlib.inflateRawSync(data);
      return null;
    },
    close: () => fh.close(),
  };
}

const attrs = tag => {
  const o = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1].toLowerCase()] = (m[2] ?? m[3]).replace(/&amp;/g, '&');
  return o;
};
const resolve = (base, href) => { try { return path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(href.split('#')[0]))); } catch { return null; } };
// 页面里第一张图（<img src> 或 SVG <image xlink:href>）
const firstImg = html => { const m = /<(?:img|image)\b[^>]*?\s(?:src|xlink:href|href)\s*=\s*["']([^"']+)["']/i.exec(html); return m?.[1]; };

const xmlText = s => s?.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim() || '';
async function epubCover(file) {
  const zip = await openZip(file); if (!zip) return null;
  try {
    const container = (await zip.read('META-INF/container.xml'))?.toString('utf8') || '';
    const opfPath = /full-path\s*=\s*["']([^"']+)["']/.exec(container)?.[1];
    const opf = opfPath && (await zip.read(opfPath))?.toString('utf8');
    if (!opf) return null;
    const meta = {
      title: xmlText(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1]),
      author: [...opf.matchAll(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map(m => xmlText(m[1])).filter(Boolean).join('、'),
    };
    const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/gi)].map(m => attrs(m[0]));
    const byId = id => items.find(i => i.id === id);
    const img = it => it && /^image\//.test(it['media-type'] || '') ? resolve(opfPath, it.href) : null;
    const page = async it => { // xhtml 页面 → 其中第一张图
      if (!it?.href) return null;
      const p = resolve(opfPath, it.href), html = p && (await zip.read(p, 4 << 20))?.toString('utf8');
      const src = html && firstImg(html);
      return src && !/^(data|https?):/i.test(src) ? resolve(p, src) : null;
    };
    const metaCover = [...opf.matchAll(/<(?:opf:)?meta\b[^>]*>/gi)].map(m => attrs(m[0])).find(a => a.name === 'cover')?.content;
    const guide = [...opf.matchAll(/<(?:opf:)?reference\b[^>]*>/gi)].map(m => attrs(m[0])).find(a => /\bcover\b/i.test(a.type || ''));
    const spine = [...opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/gi)].map(m => attrs(m[0])).filter(a => a.linear !== 'no').slice(0, 2);
    const candidates = [
      () => img(items.find(i => /\bcover-image\b/.test(i.properties || ''))),
      () => img(byId(metaCover)) || img(items.find(i => metaCover && i.href === metaCover)),
      () => guide && page({ href: guide.href }),
      ...spine.map(s => () => page(byId(s.idref))), // 没有声明封面：用首页里的图
      () => img(items.find(i => /cover/i.test(i.id + ' ' + i.href) && /^image\//.test(i['media-type'] || ''))),
    ];
    for (const c of candidates) {
      const p = await c();
      const data = p && zip.has(p) ? await zip.read(p) : null;
      if (isImage(data)) return { ...meta, data };
    }
    return meta;
  } finally { await zip.close(); }
}

// MOBI / AZW3：EXTH 201（封面偏移）+ 首个图片记录；没有声明时取第一张图
async function mobiCover(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const head = await readAt(fh, 0, 78);
    if (head.length < 78 || !/^(BOOKMOBI|TEXtREAd)$/.test(head.subarray(60, 68).toString('latin1'))) return null;
    const n = head.readUInt16BE(76);
    const tbl = await readAt(fh, 78, n * 8);
    const { size } = await fh.stat();
    const off = i => i < n ? tbl.readUInt32BE(i * 8) : size;
    const rec = async (i, max = 8 << 20) => i < n && off(i + 1) > off(i) ? readAt(fh, off(i), Math.min(off(i + 1) - off(i), max)) : null;
    const r0 = await rec(0, 1 << 20);
    if (!r0 || r0.length < 132 || r0.subarray(16, 20).toString('latin1') !== 'MOBI') return null;
    const hlen = r0.readUInt32BE(20), firstImage = r0.readUInt32BE(108);
    if (!firstImage || firstImage >= n) return null;
    let coverOff = null, thumbOff = null, title = '';
    const authors = [];
    const dec = b => (r0.readUInt32BE(28) === 65001 ? b.toString('utf8') : b.toString('latin1')).replace(/\0+$/, '').trim();
    if (r0.readUInt32BE(128) & 0x40 && r0.subarray(16 + hlen, 20 + hlen).toString('latin1') === 'EXTH') {
      const cnt = r0.readUInt32BE(24 + hlen);
      for (let p = 28 + hlen, k = 0; k < cnt && p + 8 <= r0.length; k++) {
        const type = r0.readUInt32BE(p), len = r0.readUInt32BE(p + 4);
        if (len < 8) break;
        if (len === 12 && type === 201) coverOff = r0.readUInt32BE(p + 8);
        if (len === 12 && type === 202) thumbOff = r0.readUInt32BE(p + 8);
        if (type === 503) title = dec(r0.subarray(p + 8, p + len));
        if (type === 100) authors.push(dec(r0.subarray(p + 8, p + len)));
        p += len;
      }
    }
    if (!title) { const fo = r0.readUInt32BE(84), fl = r0.readUInt32BE(88); if (fl && fo + fl <= r0.length) title = dec(r0.subarray(fo, fo + fl)); }
    // 作者里常混进来源网站名（如 xxx.com），去掉
    const meta = { title, author: authors.filter(a => a && !/^[\w-]+(\.[\w-]+)+$/.test(a)).join('、') };
    for (const o of [coverOff, thumbOff]) {
      if (o == null || o === 0xFFFFFFFF) continue;
      const data = await rec(firstImage + o);
      if (isImage(data)) return { ...meta, data };
    }
    for (let i = firstImage; i < Math.min(n, firstImage + 20); i++) { const data = await rec(i); if (isImage(data)) return { ...meta, data }; }
    return meta;
  } finally { await fh.close(); }
}

async function fb2Cover(file, ext) {
  let xml;
  if (ext === 'fbz') {
    const zip = await openZip(file); if (!zip) return null;
    try { const n = zip.names.find(n => /\.fb2$/i.test(n)) || zip.names[0]; xml = (await zip.read(n))?.toString('utf8'); } finally { await zip.close(); }
  } else {
    const st = await fsp.stat(file); if (st.size > 60 << 20) return null;
    xml = await fsp.readFile(file, 'latin1'); // 只取 ASCII 部分（id 与 base64），编码无关
  }
  if (!xml) return null;
  const href = /<coverpage\b[\s\S]*?<image\b[^>]*?href\s*=\s*["']#?([^"']+)["']/i.exec(xml)?.[1];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bin = href && new RegExp(`<binary\\b[^>]*\\bid\\s*=\\s*["']${esc(href)}["'][^>]*>([^<]+)</binary>`, 'i').exec(xml)?.[1];
  const data = bin && Buffer.from(bin.replace(/\s+/g, ''), 'base64');
  return isImage(data) ? data : null;
}

async function cbzCover(file) {
  const zip = await openZip(file); if (!zip) return null;
  try {
    const coll = new Intl.Collator('en', { numeric: true });
    const first = zip.names.filter(n => /\.(jpe?g|png|gif|webp)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n)).sort(coll.compare)[0];
    const data = first && await zip.read(first);
    return isImage(data) ? data : null;
  } finally { await zip.close(); }
}

// 统一缩成 480 宽 JPEG；没有 ImageMagick 时原样保存（浏览器按内容识别图片格式）
const magick = (await has('magick')) ? 'magick' : (await has('convert')) ? 'convert' : null;
async function saveCover(data, id) {
  const out = path.join(COVERS, id + '.jpg');
  if (magick) {
    const src = path.join(DATA, `.cover-${process.pid}`);
    try {
      await fsp.writeFile(src, data);
      await run(magick, [src + '[0]', '-auto-orient', '-thumbnail', '480x>', '-background', 'white', '-flatten', '-quality', '84', '-strip', 'jpg:' + out], { timeout: 60e3 });
      if (fs.existsSync(out)) return true;
    } catch (e) { console.warn('cover resize failed', id, e.message); } finally { await fsp.rm(src, { force: true }); }
  }
  await fsp.writeFile(out, data);
  return true;
}
// 返回 { cover, title, author }：封面写入 covers/，书名作者取自书内元数据
async function bookMeta(file, ext, id) {
  try {
    const r = ext === 'epub' ? await epubCover(file)
      : ['mobi', 'azw', 'azw3'].includes(ext) ? await mobiCover(file)
      : ['fb2', 'fbz'].includes(ext) ? { data: await fb2Cover(file, ext) }
      : ext === 'cbz' ? { data: await cbzCover(file) } : null;
    return { cover: r?.data ? await saveCover(r.data, id) : false, title: r?.title || '', author: r?.author || '' };
  } catch (e) { console.warn('cover failed', file, e.message); return { cover: false }; }
}
// 书内书名常带宣传语：「史记（全12册）【真正的无障碍阅读版！…】」→「史记（全12册）」
const cleanMetaTitle = t => {
  t = (t || '').replace(/\s+/g, ' ').trim();
  const short = t.replace(/\s*【[^】]*】\s*$/, '').trim();
  t = short || t;
  return /^(unknown|untitled|未知|无标题|未命名)$/i.test(t) ? '' : t;
};

await fsp.mkdir(COVERS, { recursive: true });
// ---------- 摘要：书中第一段正文 ----------
// 挑段规则与 app/js/summary.js 保持一致（浏览器为服务器读不了的格式补算）
const SV = 6; // 摘要规则版本：改了规则就加一，已扫描的书会重新提取
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', middot: '·', bull: '•' };
const decodeEnt = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()] ?? m;
  try { return String.fromCodePoint(/x/i.test(e[1]) ? parseInt(e.slice(2), 16) : +e.slice(1)); } catch { return ''; }
});
const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_GAP = new RegExp(`([${CJK}]) (?=[${CJK}])`, 'g'), CJK_END = new RegExp(`[${CJK}]$`), CJK_START = new RegExp(`^[${CJK}]`);
const norm = s => s.replace(/[\s ]+/g, ' ').replace(CJK_GAP, '$1').trim();
const joinLines = ls => ls.map(l => l.trim()).filter(Boolean)
  .reduce((a, l) => !a ? l : a.endsWith('-') ? a.slice(0, -1) + l : CJK_END.test(a) || CJK_START.test(l) ? a + l : a + ' ' + l, '');
// HTML → 段落（去掉注音 <rt>、脚本样式；块级标签处断开）
const htmlParas = html => html
  .replace(/<(script|style|head|title|rt|rp)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .split(/<\/?(?:p|div|h[1-6]|li|br|blockquote|tr|td|th|section|article|aside|header|footer|dd|dt|table|ul|ol|figure|figcaption|hr)\b[^>]*>/i)
  .map(s => norm(decodeEnt(s.replace(/<[^>]+>/g, ''))))
  .filter(Boolean);
// 排版好的行（PDF 文字层）→ 段落：短而不带标点的行是标题、目录、页眉，单独成段；
// 行尾是句末标点且明显短于正文行宽时，段落结束。服务器与浏览器两边一致
const lineWidth = l => { let w = 0; for (const ch of l) w += /[⺀-鿿豈-￯]/.test(ch) ? 2 : 1; return w; }; // 汉字按两格算
function lineParas(lines) {
  lines = lines.map(l => l.trim());
  // 正文行宽取较长那部分行的典型宽度（第 80 百分位），免得一行超长的英文把汉字行都衬成「短行」
  const ws = lines.map(lineWidth).filter(w => w > 10).sort((a, b) => a - b);
  const full = ws.length ? ws[Math.floor(ws.length * .8)] : 0;
  const out = []; let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  for (const l of lines) {
    if (!l) { flush(); continue; }
    const ends = /[。！？」”』…：:.!?；;，,]$/.test(l), w = lineWidth(l);
    if (!ends && w < full * .6) { flush(); out.push([l]); continue; }
    cur.push(l);
    if (/[。！？」”』…：:.!?]$/.test(l) && w < full * .8) flush();
  }
  flush();
  return out.map(ls => norm(joinLines(ls))).filter(Boolean);
}
// 纯文本 → 段落：空行多（硬换行排版）时按空行分段，否则一行一段
function textParas(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.filter(l => !l.trim()).length > lines.length * .25) return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(b => norm(joinLines(b.split('\n')))).filter(Boolean);
  return lines.map(norm).filter(Boolean);
}
function mdParas(text) {
  text = text.replace(/\r\n?/g, '\n').replace(/^```[\s\S]*?^```/gm, '').replace(/^\$\$[\s\S]*?^\$\$/gm, '');
  return text.split(/\n\s*\n/).filter(b => !/^\s*(#|\||<|!\[|---|\*\*\*|===)/.test(b))
    .map(b => norm(joinLines(b.split('\n').map(l => l.replace(/^\s*(>\s*)+/, '').replace(/^\s*([-*+]|\d+[.)])\s+/, '')))
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '')))
    .filter(Boolean);
}
// 版权页、出版信息、目录之类不算正文
const BOILER = /版权所有|版权信息|版权声明|ISBN|出版社|出版发行|印\s*刷|定\s*价|开\s*本|印\s*张|字\s*数|版\s*次|印\s*次|书\s*号|在版编目|CIP|Copyright|©|All rights reserved|电子书|免责声明|仅供.{0,6}(学习|交流|参考)|www\.|https?:\/\/|扫描|责任编辑|装帧设计|目\s*录|Contents/i;
// 目录引导点（……、.....）、连着几章的章名（目录）、文字层乱码（「再創創創造造造」这类叠字）也不算
const junkPara = t => BOILER.test(t) || /\.{4,}|…{3,}|·{4,}|-{4,}|_{4,}/.test(t)
  || (t.match(/第[一二三四五六七八九十百千\d]+[章节篇部讲回卷]/g) || []).length >= 3
  || [...t].filter((c, i, a) => i && c === a[i - 1] && c !== ' ').length > t.length * .2
  || (t.match(/([\u3400-\u9fff])\1\1/g) || []).length >= 2;
const cjkCount = t => (t.match(/[㐀-鿿]/g) || []).length;
// 正文要有真正的句读：中文看逗号、句号（顿号多见于目录和列表），西文看句末标点；
// 中文还要求句读够密（每 40 字至少一个），目录连成一片时只有零星标点
const sentence = (t, cjk) => cjk >= 5 ? (t.match(/[，。；！？]/g) || []).length >= Math.max(1, cjk / 40) : /[.!?](\s|$)/.test(t);
function goodPara(t) {
  if (junkPara(t)) return false;
  const cjk = cjkCount(t);
  return sentence(t, cjk) && (cjk >= 30 || (cjk < 5 && t.length >= 120 && t.split(/\s+/).length >= 18));
}
// 过长时在句末截断
function clip(t, max = 220) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(...['。', '！', '？', '；', '. ', '! ', '? '].map(p => cut.lastIndexOf(p)));
  return end >= max * .45 ? cut.slice(0, end + 1).trim() : cut.replace(/[，,、；;\s]+$/, '') + '…';
}
const pick = paras => { for (const p of paras) if (goodPara(p)) return clip(p); return ''; };
// 整个扫描范围都没有像样的长段落时（短文、单页讲义），退而取第一句像正文的话
const loosePara = t => { const cjk = cjkCount(t); return !junkPara(t) && sentence(t, cjk) && (cjk >= 10 || (cjk < 5 && t.length >= 40)); };
const pickLoose = paras => { const p = paras.find(loosePara); return p ? clip(p) : ''; };
const pickAny = paras => pick(paras) || pickLoose(paras);

// 文本解码：BOM → UTF-8（容忍末尾被截断的半个字）→ GB18030
function decodeBuf(buf, label) {
  if (label) { try { return new TextDecoder(label).decode(buf); } catch {} }
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) { try { return new TextDecoder('utf-16be').decode(buf.subarray(2)); } catch {} }
  for (let k = 0; k < 4 && k < buf.length; k++) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - k)); } catch {} }
  try { return new TextDecoder('gb18030').decode(buf); } catch { return buf.toString('latin1'); }
}
async function head(file, n) { const fh = await fsp.open(file, 'r'); try { return await readAt(fh, 0, n); } finally { await fh.close(); } }

async function epubSummary(file) {
  const zip = await openZip(file); if (!zip) return '';
  try {
    const container = (await zip.read('META-INF/container.xml'))?.toString('utf8') || '';
    const opfPath = /full-path\s*=\s*["']([^"']+)["']/.exec(container)?.[1];
    const opf = opfPath && (await zip.read(opfPath))?.toString('utf8');
    if (!opf) return '';
    const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/gi)].map(m => attrs(m[0]));
    const spine = [...opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/gi)].map(m => attrs(m[0])).filter(a => a.linear !== 'no');
    const seen = [];
    for (const s of spine.slice(0, 60)) {
      const it = items.find(i => i.id === s.idref), p = it && resolve(opfPath, it.href);
      const html = p && (await zip.read(p, 8 << 20))?.toString('utf8');
      if (!html) continue;
      const paras = htmlParas(html.replace(/^[\s\S]*?<body\b[^>]*>/i, ''));
      const hit = pick(paras); if (hit) return hit;
      seen.push(...paras);
    }
    // 书里没有长段落：先用简介，再退而取第一句像正文的话
    return pickAny(htmlParas(xmlText(/<dc:description\b[^>]*>([\s\S]*?)<\/dc:description>/i.exec(opf)?.[1] || ''))) || pickLoose(seen);
  } finally { await zip.close(); }
}

// MOBI / AZW3 正文：PalmDOC 压缩或不压缩的文本记录（HUFF/CDIC 压缩的交给浏览器补算）
function palmdoc(src) {
  const out = Buffer.alloc(src.length * 5 + 16); let o = 0;
  for (let i = 0; i < src.length;) {
    const c = src[i++];
    if (c === 0 || (c >= 9 && c <= 0x7f)) out[o++] = c;
    else if (c <= 8) { for (let k = 0; k < c && i < src.length; k++) out[o++] = src[i++]; }
    else if (c >= 0xc0) { out[o++] = 0x20; out[o++] = c ^ 0x80; }
    else {
      const x = ((c << 8) | src[i++]) & 0x3fff, dist = x >> 3, len = (x & 7) + 3;
      if (!dist || dist > o) break;
      for (let k = 0; k < len; k++, o++) out[o] = out[o - dist];
    }
  }
  return out.subarray(0, o);
}
// 去掉文本记录末尾的附加数据（倒序变长整数记长度），再去掉多字节残片
function trimTrailing(b, flags) {
  let end = b.length;
  for (let bit = 1; bit < 16; bit++) {
    if (!(flags & (1 << bit))) continue;
    let v = 0; for (const x of b.subarray(Math.max(0, end - 4), end)) { if (x & 0x80) v = 0; v = (v << 7) | (x & 0x7f); }
    end -= v; if (end <= 0) return b.subarray(0, 0);
  }
  if (flags & 1) end -= (b[end - 1] & 3) + 1;
  return b.subarray(0, Math.max(0, end));
}
async function mobiSummary(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const hd = await readAt(fh, 0, 78);
    if (hd.length < 78 || !/^(BOOKMOBI|TEXtREAd)$/.test(hd.subarray(60, 68).toString('latin1'))) return '';
    const n = hd.readUInt16BE(76), tbl = await readAt(fh, 78, n * 8), { size } = await fh.stat();
    const off = i => i < n ? tbl.readUInt32BE(i * 8) : size;
    const rec = async (i, max = 1 << 20) => i < n && off(i + 1) > off(i) ? readAt(fh, off(i), Math.min(off(i + 1) - off(i), max)) : null;
    const r0 = await rec(0);
    if (!r0 || r0.length < 132) return '';
    const comp = r0.readUInt16BE(0), count = r0.readUInt16BE(8);
    if (comp !== 1 && comp !== 2) return null; // HUFF/CDIC：服务器不解，交给浏览器
    const isMobi = r0.subarray(16, 20).toString('latin1') === 'MOBI', hlen = isMobi ? r0.readUInt32BE(20) : 0;
    const flags = isMobi && hlen >= 0xE4 && r0.length >= 0xF4 ? r0.readUInt16BE(0xF2) : 0;
    const label = isMobi && r0.readUInt32BE(28) === 65001 ? 'utf-8' : 'windows-1252';
    const parts = [];
    for (let i = 1; i <= Math.min(count, 160); i++) {
      let b = await rec(i); if (!b) break;
      b = trimTrailing(b, flags);
      parts.push(comp === 2 ? palmdoc(b) : b);
      if (i % 20 === 0 || i === Math.min(count, 160)) {
        const paras = htmlParas(new TextDecoder(label).decode(Buffer.concat(parts)));
        const hit = i === Math.min(count, 160) ? pickAny(paras) : pick(paras);
        if (hit) return hit;
      }
    }
    return '';
  } finally { await fh.close(); }
}

async function pdfSummary(file) {
  if (!canPdfText) return null;
  const { stdout } = await run('pdftotext', ['-f', '1', '-l', '40', '-enc', 'UTF-8', '-q', file, '-'], { maxBuffer: 16 << 20, timeout: 60e3 });
  return pickAny(stdout.split('\f').flatMap(pg => lineParas(pg.split('\n'))));
}
async function docxSummary(file) {
  const zip = await openZip(file); if (!zip) return '';
  try {
    const xml = (await zip.read('word/document.xml', 40 << 20))?.toString('utf8') || '';
    return pickAny(xml.split(/<\/w:p>/).slice(0, 600).map(p => norm(decodeEnt([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('')))).filter(Boolean));
  } finally { await zip.close(); }
}
async function fb2Summary(file, ext) {
  let buf;
  if (ext === 'fbz') {
    const zip = await openZip(file); if (!zip) return '';
    try { buf = await zip.read(zip.names.find(n => /\.fb2$/i.test(n)) || zip.names[0]); } finally { await zip.close(); }
  } else buf = await head(file, 4 << 20);
  if (!buf) return '';
  const label = /encoding\s*=\s*["']([\w-]+)["']/i.exec(buf.subarray(0, 200).toString('latin1'))?.[1];
  const xml = decodeBuf(buf, label);
  return pickAny(htmlParas(/<body\b[^>]*>([\s\S]*)/i.exec(xml)?.[1] || xml));
}
async function zipMdSummary(file) {
  const zip = await openZip(file); if (!zip) return '';
  try {
    const md = zip.names.filter(n => /\.(md|markdown)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n)).sort()[0];
    const buf = md && await zip.read(md, 8 << 20);
    return buf ? pickAny(mdParas(decodeBuf(buf))) : '';
  } finally { await zip.close(); }
}
// 返回摘要字符串；'' 表示读过但没找到合适的段落；null 表示服务器读不了这种格式（由浏览器补算）
async function bookSummary(file, ext) {
  try {
    switch (ext) {
      case 'pdf': return await pdfSummary(file);
      case 'epub': return await epubSummary(file);
      case 'mobi': case 'azw': case 'azw3': return await mobiSummary(file);
      case 'txt': return pickAny(textParas(decodeBuf(await head(file, 256 << 10))));
      case 'md': case 'markdown': return pickAny(mdParas(decodeBuf(await head(file, 512 << 10))));
      case 'html': case 'htm': case 'xhtml': { const t = decodeBuf(await head(file, 2 << 20)); return pickAny(htmlParas(t.replace(/^[\s\S]*?<body\b[^>]*>/i, ''))); }
      case 'docx': return await docxSummary(file);
      case 'fb2': case 'fbz': return await fb2Summary(file, ext);
      case 'zip': return await zipMdSummary(file);
      default: return null; // doc、cbz
    }
  } catch (e) { console.warn('summary failed', file, e.message); return null; }
}

const md5File = file => new Promise((res, rej) => {
  const h = crypto.createHash('md5');
  fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

const cache = await readJSON(CACHE_FILE, {});
const canPdf = await has('pdfinfo');
const canPdfText = await has('pdftotext');
const books = [];
const seen = new Set(), seenMd5 = new Set();

for await (const file of walk(BOOKS)) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!EXT.has(ext)) continue;
  const rel = path.relative(BOOKS, file).split(path.sep).join('/');
  const st = await fsp.stat(file);
  let c = cache[rel];
  // v3：PDF 封面改为首页（旧版会跳过浅色首页），并为 EPUB / MOBI / AZW3 / FB2 / CBZ 提取封面
  if (!c || c.size !== st.size || c.mtime !== Math.floor(st.mtimeMs) || c.v !== 3) {
    c = { v: 3, size: st.size, mtime: Math.floor(st.mtimeMs), id: await contentId(file, st.size), added: c?.added || Date.now() };
    if (ext === 'pdf' && canPdf) {
      const info = await pdfInfo(file);
      Object.assign(c, { pages: info.pages, pdfTitle: info.title, pdfAuthor: info.author, aspect: info.w && info.h ? +(info.w / info.h).toFixed(4) : null });
      c.cover = await pdfCover(file, c.id, info.pages);
      if (!c.cover) await fsp.rm(path.join(COVERS, c.id + '.jpg'), { force: true });
    } else if (ext !== 'pdf') {
      const m = await bookMeta(file, ext, c.id); // 提取不到封面时保留客户端回传的那张
      Object.assign(c, { cover: m.cover, metaTitle: m.title, metaAuthor: m.author });
    }
    console.log('scanned', rel);
  }
  if (!c.md5) c.md5 = await md5File(file);
  if (c.sv !== SV) { c.summary = await bookSummary(file, ext); c.sv = SV; }
  cache[rel] = c;
  if (seen.has(c.id) || seenMd5.has(c.md5)) continue; // 同一本书（MD5 相同）的重复副本只收一次
  seen.add(c.id); seenMd5.add(c.md5);

  const base = path.basename(file, path.extname(file));
  const parts = rel.split('/');
  const folder = parts.length > 1 ? parts[0] : null;
  const seriesMeta = folder && META.series?.[folder];
  const m = META.books?.[base] || {};
  const coverStat = fs.statSync(path.join(COVERS, c.id + '.jpg'), { throwIfNoEntry: false });
  const book = {
    id: c.id,
    path: rel,
    format: FORMAT[ext] || ext,
    title: m.title || cleanMetaTitle(c.metaTitle) || cleanTitle(base),
    author: m.author ?? seriesMeta?.author ?? '',
    category: m.category || seriesMeta?.category || (folder === '上传' ? '' : '') || '',
    series: folder && folder !== '上传' ? (seriesMeta?.title || folder) : null,
    volume: m.volume ?? (folder && folder !== '上传' ? guessVolume(base) : null),
    size: c.size,
    pages: c.pages || null,
    aspect: c.aspect || null,
    md5: c.md5,
    summary: c.summary ?? undefined, // '' = 读过但没有合适段落；缺省 = 服务器读不了，由浏览器补
    cover: !!coverStat,
    coverV: coverStat ? Math.floor(coverStat.mtimeMs / 1000).toString(36) : undefined, // 封面换了就换 URL，绕过浏览器缓存
    added: c.added,
  };
  const junk = /^(user|admin|administrator|微软用户|unknown|未知|佚名|作者|author:?.*|creator:?.*|subject:?.*|new|lenovo|owner|pc|[\d\s]+|.*[.](dll|exe|doc|pdf)|.{0,1})$/i;
  const embedded = (c.pdfAuthor || c.metaAuthor || '').trim();
  if (!book.author && !META.books?.[base] && embedded && !junk.test(embedded)) book.author = embedded;
  books.push(book);
}

for (const k of Object.keys(cache)) if (!fs.existsSync(path.join(BOOKS, k))) delete cache[k];
await fsp.writeFile(CACHE_FILE, JSON.stringify(cache));

const coll = new Intl.Collator('zh-Hans-CN', { numeric: true });
books.sort((a, b) => coll.compare(a.series || a.title, b.series || b.title) || (a.volume ?? 0) - (b.volume ?? 0) || coll.compare(a.title, b.title));
const out = { generatedAt: Date.now(), categories: META.categories || [], books };
const tmp = path.join(DATA, 'catalog.json.tmp');
await fsp.writeFile(tmp, JSON.stringify(out));
await fsp.rename(tmp, path.join(DATA, 'catalog.json'));
console.log(`catalog: ${books.length} books`);
