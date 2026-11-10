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
const UPLOAD_LIMIT = 512 * 1024 * 1024;
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

let building = null;
function rebuildCatalog() {
  if (building) return building;
  building = new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, 'build-catalog.mjs')], { cwd: ROOT, env: { ...process.env, BOOKS_DIR: BOOKS, DATA_DIR: DATA }, stdio: 'inherit' });
    p.on('close', code => { building = null; catalogCache = null; resolve(code); });
  });
  return building;
}

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
    ov[arg] = { ...(ov[arg] || {}), ...clean };
    await writeJSON(OVERRIDES, ov);
    catalogCache = null;
    return json(res, 200, { ok: true });
  }

  if (name === 'upload' && method === 'PUT') {
    let fname = (url.searchParams.get('name') || '').normalize('NFC');
    fname = path.basename(fname).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
    const ext = path.extname(fname).slice(1).toLowerCase();
    if (!fname || !BOOK_EXT.has(ext)) return json(res, 400, { error: '不支持的格式' });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    let target = path.join(UPLOAD_DIR, fname);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(UPLOAD_DIR, fname.replace(/(\.[^.]+)$/, `（${i}）$1`));
    const tmp = target + '.part';
    const out = fs.createWriteStream(tmp);
    let n = 0;
    try {
      for await (const c of req) { n += c.length; if (n > UPLOAD_LIMIT) throw Object.assign(new Error('文件太大'), { code: 413 }); if (!out.write(c)) await new Promise(r => out.once('drain', r)); }
      await new Promise((r, j) => out.end(e => e ? j(e) : r()));
      await fsp.rename(tmp, target);
    } catch (e) { out.destroy(); await fsp.rm(tmp, { force: true }); throw e; }
    await rebuildCatalog();
    const rel = path.relative(BOOKS, target).split(path.sep).join('/');
    const book = (await catalog()).books.find(b => b.path === rel);
    return json(res, 200, { ok: true, book });
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
