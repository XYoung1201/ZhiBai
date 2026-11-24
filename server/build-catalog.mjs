// 扫描书库目录 → data/catalog.json；PDF 用 poppler 取页数与封面。增量：未变化的文件不重复处理。
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
const cache = await readJSON(CACHE_FILE, {});
const canPdf = await has('pdfinfo');
const books = [];
const seen = new Set();

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
  cache[rel] = c;
  if (seen.has(c.id)) continue; // 同一本书的重复副本只收一次
  seen.add(c.id);

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
