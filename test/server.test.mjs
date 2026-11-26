// 起一个真实的服务进程（临时书库与数据目录），走 HTTP 测上传、MD5 去重与分片上传
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibai-test-'));
const BOOKS = path.join(tmp, 'books'), DATA = path.join(tmp, 'data');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}/read/api/`;
let proc, cookie;

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');
const api = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
const txt = s => Buffer.from(s + '\n' + crypto.randomUUID()); // 每本内容唯一

before(async () => {
  fs.mkdirSync(BOOKS, { recursive: true }); fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'key.txt'), 'testkey\n');
  proc = spawn(process.execPath, [path.join(here, '../server/server.js')], {
    env: { ...process.env, PORT: String(PORT), BOOKS_DIR: BOOKS, DATA_DIR: DATA, BASE: '/read' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
    proc.on('exit', code => reject(new Error('server exited ' + code)));
  });
  const r = await fetch(BASE + 'login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'testkey' }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => { proc?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('未登录不能访问书目', async () => {
  assert.equal((await fetch(BASE + 'catalog')).status, 401);
});

test('钥匙不对返回 401', async () => {
  const r = await fetch(BASE + 'login', { method: 'POST', body: JSON.stringify({ key: 'nope' }) });
  assert.equal(r.status, 401);
});

test('上传入库，并按 MD5 去重', async () => {
  const body = txt('第一本书');
  const r1 = await (await api(`upload?name=${encodeURIComponent('甲.txt')}&md5=${md5(body)}`, { method: 'PUT', body })).json();
  assert.equal(r1.ok, true);
  assert.equal(r1.existed, undefined);
  assert.equal(r1.book.md5, md5(body));
  assert.ok(fs.existsSync(path.join(BOOKS, '上传', '甲.txt')));

  // 换个文件名再传：返回已有那本，不多存一份
  const r2 = await (await api(`upload?name=${encodeURIComponent('乙.txt')}`, { method: 'PUT', body })).json();
  assert.equal(r2.existed, true);
  assert.equal(r2.book.id, r1.book.id);
  assert.ok(!fs.existsSync(path.join(BOOKS, '上传', '乙.txt')));

  const ex = await (await api('exists?md5=' + md5(body))).json();
  assert.equal(ex.book.id, r1.book.id);
  assert.equal((await (await api('exists?md5=' + 'f'.repeat(32))).json()).book, null);
  assert.equal((await api('exists?md5=xyz')).status, 400);
});

test('同名不同内容的书另存一份', async () => {
  const a = txt('丙 v1'), b = txt('丙 v2');
  await api(`upload?name=${encodeURIComponent('丙.txt')}`, { method: 'PUT', body: a });
  const r = await (await api(`upload?name=${encodeURIComponent('丙.txt')}`, { method: 'PUT', body: b })).json();
  assert.equal(r.ok, true);
  assert.equal(r.book.path, '上传/丙（2）.txt');
});

test('MD5 对不上时拒收', async () => {
  const r = await api(`upload?name=x.txt&md5=${'0'.repeat(32)}`, { method: 'PUT', body: txt('坏') });
  assert.equal(r.status, 409);
  assert.deepEqual(fs.readdirSync(path.join(BOOKS, '上传')).filter(n => n.endsWith('.part')), []);
});

test('拒绝不支持的扩展名与路径穿越', async () => {
  assert.equal((await api('upload?name=evil.sh', { method: 'PUT', body: 'x' })).status, 400);
  const r = await (await api(`upload?name=${encodeURIComponent('../../escape.md')}`, { method: 'PUT', body: txt('esc') })).json();
  assert.equal(r.book.path, '上传/escape.md');
});

test('分片上传：续传、合并、去重', async () => {
  const body = Buffer.concat([txt('分片书'), crypto.randomBytes(300_000)]);
  const id = crypto.randomUUID();
  const parts = [body.subarray(0, 100_000), body.subarray(100_000, 200_000), body.subarray(200_000)];
  let r = await (await api(`chunk/${id}?offset=0`, { method: 'PUT', body: parts[0] })).json();
  assert.equal(r.size, 100_000);
  // 重发同一块（比如响应丢了）：409 并告知已收字节数
  let res = await api(`chunk/${id}?offset=0`, { method: 'PUT', body: parts[0] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).size, 100_000);
  await api(`chunk/${id}?offset=100000`, { method: 'PUT', body: parts[1] });
  // 声明的总大小不符：不合并
  res = await api(`chunk/${id}?name=big.md&size=${body.length}`, { method: 'POST' });
  assert.equal(res.status, 409);
  await api(`chunk/${id}?offset=200000`, { method: 'PUT', body: parts[2] });
  r = await (await api(`chunk/${id}?name=big.md&size=${body.length}&md5=${md5(body)}`, { method: 'POST' })).json();
  assert.equal(r.ok, true);
  assert.equal(r.book.md5, md5(body));
  assert.deepEqual(fs.readFileSync(path.join(BOOKS, '上传', 'big.md')), body);

  // 同一本再分片传一次：合并后发现已有，直接返回
  const id2 = crypto.randomUUID();
  await api(`chunk/${id2}?offset=0`, { method: 'PUT', body });
  const r2 = await (await api(`chunk/${id2}?name=other.md`, { method: 'POST' })).json();
  assert.equal(r2.existed, true);
  assert.equal(r2.book.id, r.book.id);
  assert.deepEqual(fs.readdirSync(path.join(BOOKS, '上传')).filter(n => n.endsWith('.part')), []);
});

test('分片上传：坏 id、MD5 不符与放弃', async () => {
  assert.equal((await api('chunk/../x?offset=0', { method: 'PUT', body: 'x' })).status, 404);
  assert.equal((await api('chunk/not-a-uuid?offset=0', { method: 'PUT', body: 'x' })).status, 400);
  const id = crypto.randomUUID();
  await api(`chunk/${id}?offset=0`, { method: 'PUT', body: txt('md5 坏') });
  assert.equal((await api(`chunk/${id}?name=a.md&md5=${'0'.repeat(32)}`, { method: 'POST' })).status, 409);
  const id2 = crypto.randomUUID();
  await api(`chunk/${id2}?offset=0`, { method: 'PUT', body: 'abc' });
  assert.equal((await api(`chunk/${id2}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`chunk/${id2}?name=a.md`, { method: 'POST' })).status, 404);
});
