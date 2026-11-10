// 扫描书库目录 → data/catalog.json；PDF 用 poppler 取页数与封面。增量：未变化的文件不重复处理。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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
// 估算一页的「墨量」：近乎空白的首页（扫描书常见）不拿来当封面
async function pageInk(file, page) {
  const probe = path.join(DATA, '.probe-' + process.pid);
  try {
    await run('pdftoppm', ['-gray', '-scale-to', '48', '-f', String(page), '-l', String(page), '-singlefile', file, probe], { timeout: 60e3 });
    const buf = await fsp.readFile(probe + '.pgm');
    const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 40).toString('latin1'));
    if (!m) return 1;
    const px = buf.subarray(m[0].length);
    let dark = 0; for (const v of px) if (v < 200) dark++;
    return dark / px.length;
  } catch { return 1; } finally { await fsp.rm(probe + '.pgm', { force: true }); }
}
async function pdfCover(file, id, pages = 1) {
  const out = path.join(COVERS, id);
  let page = 1;
  for (let p = 1; p <= Math.min(3, pages || 1); p++) { if (await pageInk(file, p) > .02) { page = p; break; } if (p === Math.min(3, pages || 1)) return false; }
  try {
    await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=84,progressive=y', '-scale-to-x', '480', '-scale-to-y', '-1', '-f', String(page), '-l', String(page), '-singlefile', file, out], { timeout: 120e3 });
    return fs.existsSync(out + '.jpg');
  } catch (e) { console.warn('cover failed', file, e.message); return false; }
}

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
  if (!c || c.size !== st.size || c.mtime !== Math.floor(st.mtimeMs) || c.v !== 2) {
    c = { v: 2, size: st.size, mtime: Math.floor(st.mtimeMs), id: await contentId(file, st.size), added: c?.added || Date.now() };
    if (ext === 'pdf' && canPdf) {
      const info = await pdfInfo(file);
      Object.assign(c, { pages: info.pages, pdfTitle: info.title, pdfAuthor: info.author, aspect: info.w && info.h ? +(info.w / info.h).toFixed(4) : null });
      c.cover = await pdfCover(file, c.id, info.pages);
      if (!c.cover) await fsp.rm(path.join(COVERS, c.id + '.jpg'), { force: true });
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
  const book = {
    id: c.id,
    path: rel,
    format: FORMAT[ext] || ext,
    title: m.title || cleanTitle(base),
    author: m.author ?? seriesMeta?.author ?? '',
    category: m.category || seriesMeta?.category || (folder === '上传' ? '' : '') || '',
    series: folder && folder !== '上传' ? (seriesMeta?.title || folder) : null,
    volume: m.volume ?? (folder && folder !== '上传' ? guessVolume(base) : null),
    size: c.size,
    pages: c.pages || null,
    aspect: c.aspect || null,
    cover: !!c.cover || fs.existsSync(path.join(COVERS, c.id + '.jpg')),
    added: c.added,
  };
  const junk = /^(user|admin|administrator|微软用户|unknown|作者|author:?.*|creator:?.*|subject:?.*|new|lenovo|owner|pc|[\d\s]+|.*[.](dll|exe|doc|pdf)|.{0,1})$/i;
  if (!book.author && !META.books?.[base] && c.pdfAuthor && !junk.test(c.pdfAuthor.trim())) book.author = c.pdfAuthor.trim();
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
