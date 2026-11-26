// 知白 · 书库服务（零依赖 Node）
// 职责：托管阅读器前端、受保护地提供书籍文件（支持 Range 分段）、封面、阅读进度多端同步、网页上传入库。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8730);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = (process.env.BASE ?? '/read').replace(/\/+$/, '');
const APP = process.env.APP_DIR || path.join(ROOT, 'app');
const BOOKS = process.env.BOOKS_DIR || path.join(ROOT, 'books');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const COVERS = path.join(DATA, 'covers');
const CATALOG = path.join(DATA, 'catalog.json');
const OVERRIDES = path.join(DATA, 'overrides.json');
const STATE = path.join(DATA, 'state.json');
const KEYFILE = path.join(DATA, 'key.txt');
const TRASH = path.join(DATA, 'trash');
const UPLOAD_DIR = path.join(BOOKS, '上传');
const UPLOAD_LIMIT = 512 * 1024 * 1024;   // 单次 PUT 上传
const CHUNKED_LIMIT = 4 * 1024 ** 3;       // 分片上传的整本上限
const CHUNK_MAX = 32 * 1024 * 1024;        // 单个分片上限（Cloudflare 单请求 100 MB）
const PART_TTL = 24 * 3600e3;              // 未完成的分片上传保留一天
const BOOK_EXT = new Set(['pdf', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'docx', 'doc', 'cbz', 'zip']);

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
  webmanifest: 'application/manifest+json', map: 'application/json', txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', epub: 'application/epub+zip',
};

await fsp.mkdir(COVERS, { recursive: true });

// ---------- 钥匙 ----------
async function loadKey() {
  try { const k = (await fsp.readFile(KEYFILE, 'utf8')).trim(); if (k) return k; } catch {}
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const k = Array.from(crypto.randomBytes(10), b => abc[b % abc.length]).join('');
  await fsp.writeFile(KEYFILE, k + '\n', { mode: 0o600 });
  return k;
}
let KEY = await loadKey();
fs.watchFile(KEYFILE, { interval: 5000 }, async () => { KEY = await loadKey(); });
const tokenOf = k => crypto.createHmac('sha256', k).update('zhibai/v1').digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const fails = new Map(); // ip -> {n, until}
const clientIp = req => req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const authed = req => safeEq(cookies(req).zb_t || '', tokenOf(KEY));
function setTokenCookie(req, res, value, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `zb_t=${value}; Path=${BASE || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

// ---------- 小工具 ----------
function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
const json = (res, code, obj, extra = {}) => send(res, code, JSON.stringify(obj), { 'Content-Type': MIME.json, 'Cache-Control': 'no-store', ...extra });
async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('too large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJSON(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; } }
async function writeJSON(file, obj) { const tmp = file + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(obj)); await fsp.rename(tmp, file); }

// 静态文件 + Range
async function serveFile(req, res, file, { type, cache = 'no-cache', download } = {}) {
  let st;
  try { st = await fsp.stat(file); if (!st.isFile()) throw 0; } catch { return send(res, 404, 'not found', { 'Content-Type': MIME.txt }); }
  const ext = path.extname(file).slice(1).toLowerCase();
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = {
    'Content-Type': type || MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache, ETag: etag, 'Last-Modified': st.mtime.toUTCString(), 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  if (download) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(download)}`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const range = req.headers.range;
  let start = 0, end = st.size - 1, code = 200;
  if (range && /^bytes=/.test(range) && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const m = /^bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - +m[2]); }
      else { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], st.size - 1); }
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---------- 书目 ----------
let catalogCache = null, catalogMtime = 0;
async function catalog() {
  try {
    const st = await fsp.stat(CATALOG);
    const ov = await fsp.stat(OVERRIDES).catch(() => ({ mtimeMs: 0 }));
    const m = st.mtimeMs + ov.mtimeMs;
    if (!catalogCache || m !== catalogMtime) {
      const cat = await readJSON(CATALOG, { books: [] });
      const overrides = await readJSON(OVERRIDES, {});
      for (const b of cat.books) Object.assign(b, overrides[b.id] || {});
      catalogCache = cat; catalogMtime = m;
    }
  } catch { catalogCache = catalogCache || { books: [], categories: [] }; }
  return catalogCache;
}
const findBook = async id => (await catalog()).books.find(b => b.id === id);

let building = null, queued = null;
function rebuildCatalog() {
  if (!building) {
    building = new Promise(resolve => {
      const p = spawn(process.execPath, [path.join(ROOT, 'build-catalog.mjs')], { cwd: ROOT, env: { ...process.env, BOOKS_DIR: BOOKS, DATA_DIR: DATA }, stdio: 'inherit' });
      p.on('close', code => { building = null; catalogCache = null; resolve(code); });
    });
    return building;
  }
  // 正在扫描时又有新文件落盘：等这一轮结束再扫一轮，保证新文件被收录
  return queued ||= building.then(() => { queued = null; return rebuildCatalog(); });
}

// 整个文件的 MD5，用于判断「是不是同一本书」
const md5File = file => new Promise((resolve, reject) => {
  const h = crypto.createHash('md5');
  fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
const byMd5 = async md5 => (await catalog()).books.find(b => b.md5 === md5 && fs.existsSync(path.join(BOOKS, b.path)));

// 上传文件名：只留文件名本身、去掉非法字符，扩展名须是书籍格式
function cleanName(raw) {
  const fname = path.basename(String(raw || '').normalize('NFC')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
  return fname && BOOK_EXT.has(path.extname(fname).slice(1).toLowerCase()) ? fname : '';
}
async function drain(req) { for await (const _ of req); }

// 临时文件收齐后入库：校验 MD5、按 MD5 去重、避开同名文件，最后重建书目。tmp 总会被删掉。
async function finishUpload(tmp, fname, md5, want) {
  let target;
  try {
    if (want && want.toLowerCase() !== md5) return { code: 409, body: { error: '文件在传输中损坏，请重试' } };
    // 书库里已有 MD5 相同的书（重传、换了文件名再传）：直接返回那本，不再多存一份
    const have = await byMd5(md5);
    if (have) return { code: 200, body: { ok: true, book: have, existed: true } };
    for (let i = 1; ; i++) {
      target = path.join(UPLOAD_DIR, i === 1 ? fname : fname.replace(/(\.[^.]+)?$/, `（${i}）$1`));
      try { await fsp.link(tmp, target); break; } // link 在目标已存在时报 EEXIST，不会覆盖并发写入的同名文件
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (await md5File(target).catch(() => null) === md5) break; // 同名且同内容：并发的另一次已经落盘
      }
    }
  } finally { await fsp.rm(tmp, { force: true }); }
  await rebuildCatalog();
  const rel = path.relative(BOOKS, target).split(path.sep).join('/');
  const book = (await catalog()).books.find(b => b.path === rel);
  return { code: 200, body: { ok: true, book } };
}

// 清理放弃了的上传临时文件
async function sweepParts() {
  const names = await fsp.readdir(UPLOAD_DIR).catch(() => []);
  for (const n of names) {
    if (!/^\..+\.part$/.test(n)) continue;
    const f = path.join(UPLOAD_DIR, n);
    const st = await fsp.stat(f).catch(() => null);
    if (st && Date.now() - st.mtimeMs > PART_TTL) await fsp.rm(f, { force: true });
  }
}
setInterval(sweepParts, 3600e3).unref();
sweepParts();

// ---------- 进度同步 ----------
// 结构：{ books: { [id]: { progress:{...,t}, marks:{items,t}, notes:{items,t}, stats:{[device]:{[day]:sec}} } }, settings:{..., t} }
let stateCache = null, stateWrite = Promise.resolve();
async function getState() { if (!stateCache) stateCache = await readJSON(STATE, { books: {}, settings: null }); return stateCache; }
function mergeState(dst, src) {
  if (src.settings && (!dst.settings || (src.settings.t || 0) > (dst.settings.t || 0))) dst.settings = src.settings;
  for (const [id, e] of Object.entries(src.books || {})) {
    const d = dst.books[id] || (dst.books[id] = {});
    for (const k of ['progress', 'marks', 'notes', 'meta']) {
      if (e[k] && (!d[k] || (e[k].t || 0) > (d[k].t || 0))) d[k] = e[k];
    }
    if (e.stats) {
      d.stats = d.stats || {};
      for (const [dev, days] of Object.entries(e.stats)) {
        const dd = d.stats[dev] || (d.stats[dev] = {});
        for (const [day, sec] of Object.entries(days)) dd[day] = Math.max(dd[day] || 0, +sec || 0);
      }
    }
  }
  return dst;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (BASE) {
      if (p === BASE) { res.writeHead(301, { Location: BASE + '/' }); return res.end(); }
      if (!p.startsWith(BASE + '/')) return send(res, 404, 'not found');
      p = p.slice(BASE.length);
    }
    res.setHeader('Referrer-Policy', 'same-origin');

    if (p.startsWith('/api/')) return await api(req, res, p.slice(5), url);

    // 前端
    if (p === '/' || p === '/index.html') return serveFile(req, res, path.join(APP, 'index.html'), { cache: 'no-cache' });
    const rel = path.normalize(p).replace(/^([/\\])+/, '');
    const file = path.join(APP, rel);
    if (!file.startsWith(APP + path.sep)) return send(res, 403, 'forbidden');
    const longCache = /^(vendor|fonts|icons)[/\\]/.test(rel);
    return serveFile(req, res, file, { cache: longCache ? 'public, max-age=2592000, immutable' : 'no-cache' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.code === 413 ? 413 : 500, { error: String(e.message || e) });
    else res.destroy();
  }
});

async function api(req, res, route, url) {
  const [name, arg] = route.split('/');
  const method = req.method;

  if (name === 'session') return json(res, 200, { authed: authed(req) });

  if (name === 'login' && method === 'POST') {
    const ip = clientIp(req), f = fails.get(ip);
    if (f && f.until > Date.now()) return json(res, 429, { error: '尝试次数过多，请稍后再试', retry: Math.ceil((f.until - Date.now()) / 1000) });
    const { key } = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    await new Promise(r => setTimeout(r, 300));
    if (key && safeEq(String(key).trim().toLowerCase(), KEY.toLowerCase())) {
      fails.delete(ip); setTokenCookie(req, res, tokenOf(KEY), 31536000);
      return json(res, 200, { ok: true });
    }
    const n = (f?.n || 0) + 1;
    fails.set(ip, { n, until: n >= 6 ? Date.now() + 15 * 60e3 : 0 });
    return json(res, 401, { error: '钥匙不对' });
  }
  if (name === 'logout' && method === 'POST') { setTokenCookie(req, res, '', 0); return json(res, 200, { ok: true }); }

  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

  if (name === 'catalog') {
    const c = await catalog();
    return json(res, 200, c);
  }

  if (name === 'file' && arg) {
    const b = await findBook(arg); if (!b) return json(res, 404, { error: 'no book' });
    const file = path.join(BOOKS, b.path);
    if (!file.startsWith(BOOKS + path.sep)) return json(res, 403, { error: 'forbidden' });
    // 统一以二进制交付，避免中间层按 charset 改写；private 防止 CDN 缓存
    return serveFile(req, res, file, { type: b.format === 'pdf' ? MIME.pdf : 'application/octet-stream', cache: 'private, max-age=604800', download: path.basename(b.path) });
  }

  if (name === 'cover' && arg) {
    const file = path.join(COVERS, arg.replace(/[^a-z0-9]/gi, '') + '.jpg');
    if (method === 'POST') { // 客户端回传解析得到的封面（EPUB 等）
      const body = await readBody(req, 3 * 1024 * 1024);
      if (body.length < 200) return json(res, 400, { error: 'bad image' });
      await fsp.writeFile(file, body);
      rebuildCatalog(); // 让书目里的 cover 标记跟上，其他设备也能看到
      return json(res, 200, { ok: true });
    }
    return serveFile(req, res, file, { cache: 'private, max-age=86400' });
  }

  if (name === 'state') {
    const st = await getState();
    if (method === 'POST') {
      const incoming = JSON.parse((await readBody(req)).toString() || '{}');
      mergeState(st, incoming);
      stateWrite = stateWrite.then(() => writeJSON(STATE, st)).catch(console.error);
    }
    return json(res, 200, st);
  }

  if (name === 'meta' && arg && method === 'POST') {
    const patch = JSON.parse((await readBody(req, 65536)).toString() || '{}');
    const ov = await readJSON(OVERRIDES, {});
    const clean = {};
    for (const k of ['title', 'author', 'category']) if (typeof patch[k] === 'string') clean[k] = patch[k].slice(0, 200);
    if (typeof patch.summary === 'string') clean.summary = patch.summary.slice(0, 600); // 服务器读不了的格式由浏览器回填
    ov[arg] = { ...(ov[arg] || {}), ...clean };
    await writeJSON(OVERRIDES, ov);
    catalogCache = null;
    return json(res, 200, { ok: true });
  }

  // 上传前先按 MD5 问一声：已有这本就不必再传
  if (name === 'exists' && method === 'GET') {
    const md5 = (url.searchParams.get('md5') || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(md5)) return json(res, 400, { error: 'bad md5' });
    return json(res, 200, { book: (await byMd5(md5)) || null });
  }

  if (name === 'upload' && method === 'PUT') {
    const fname = cleanName(url.searchParams.get('name'));
    if (!fname) return json(res, 400, { error: '不支持的格式' });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    // 每个请求写自己的临时文件（点开头，书目扫描会跳过）。同一本书可能被并发地传两次（浏览器或 CDN 断线重发），
    // 共用一个 .part 时，先断开的那次会把另一次正在写的文件删掉，导致 rename ENOENT。
    const tmp = path.join(UPLOAD_DIR, `.${crypto.randomUUID()}.part`);
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    const hash = crypto.createHash('md5');
    let n = 0;
    try {
      for await (const c of req) { n += c.length; if (n > UPLOAD_LIMIT) throw Object.assign(new Error('文件太大'), { code: 413 }); hash.update(c); if (!out.write(c)) await new Promise(r => out.once('drain', r)); }
      await new Promise((r, j) => out.end(e => e ? j(e) : r()));
    } catch (e) { out.destroy(); await fsp.rm(tmp, { force: true }); throw e; }
    const r = await finishUpload(tmp, fname, hash.digest('hex'), url.searchParams.get('md5'));
    return json(res, r.code, r.body);
  }

  // 分片上传：大文件（超过 Cloudflare 单请求上限）切成小块依次 PUT，最后合并并按 MD5 去重
  //   PUT  api/chunk/<uuid>?offset=N   追加一块；offset 与已收字节数不符时回 409 与 { size }，客户端据此续传
  //   POST api/chunk/<uuid>?name=&md5=  收齐后合并入库
  if (name === 'chunk' && arg) {
    if (!/^[0-9a-f-]{36}$/.test(arg)) return json(res, 400, { error: 'bad id' });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    const tmp = path.join(UPLOAD_DIR, `.${arg}.chunked.part`);
    const size = (await fsp.stat(tmp).catch(() => null))?.size ?? 0;
    if (method === 'PUT') {
      const offset = +url.searchParams.get('offset');
      if (!Number.isSafeInteger(offset) || offset !== size) { await drain(req); return json(res, 409, { error: 'offset mismatch', size }); }
      const body = await readBody(req, CHUNK_MAX);
      if (size + body.length > CHUNKED_LIMIT) { await fsp.rm(tmp, { force: true }); return json(res, 413, { error: '文件太大' }); }
      await fsp.appendFile(tmp, body);
      return json(res, 200, { ok: true, size: size + body.length });
    }
    if (method === 'POST') {
      const fname = cleanName(url.searchParams.get('name'));
      if (!fname) { await fsp.rm(tmp, { force: true }); return json(res, 400, { error: '不支持的格式' }); }
      if (!size) return json(res, 404, { error: '没有收到分片' });
      const want = +url.searchParams.get('size');
      if (want && want !== size) return json(res, 409, { error: '分片不完整', size });
      const r = await finishUpload(tmp, fname, await md5File(tmp), url.searchParams.get('md5'));
      return json(res, r.code, r.body);
    }
    if (method === 'DELETE') { await fsp.rm(tmp, { force: true }); return json(res, 200, { ok: true }); }
  }

  if (name === 'book' && arg && method === 'DELETE') {
    const b = await findBook(arg); if (!b) return json(res, 404, { error: 'no book' });
    await fsp.mkdir(TRASH, { recursive: true });
    await fsp.rename(path.join(BOOKS, b.path), path.join(TRASH, Date.now() + '-' + path.basename(b.path)));
    await rebuildCatalog();
    return json(res, 200, { ok: true });
  }

  if (name === 'rescan' && method === 'POST') { await rebuildCatalog(); return json(res, 200, { ok: true, count: (await catalog()).books.length }); }

  return json(res, 404, { error: 'unknown api' });
}

server.keepAliveTimeout = 65e3;
server.listen(PORT, HOST, () => console.log(`知白 listening http://${HOST}:${PORT}${BASE || ''}/`));
if (!fs.existsSync(CATALOG)) rebuildCatalog();
