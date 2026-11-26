import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffExt, extForMime, titleFromText, textToFile, asBookFile } from '../app/js/clipboard.js';

const enc = s => new TextEncoder().encode(s);
const now = new Date(2026, 10, 26, 9, 5);

test('sniffExt 按文件头识别', () => {
  assert.equal(sniffExt(enc('%PDF-1.7\n...')), 'pdf');
  const mobi = new Uint8Array(80); mobi.set(enc('BOOKMOBI'), 60);
  assert.equal(sniffExt(mobi), 'mobi');
  assert.equal(sniffExt(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0, 0])), 'doc');
  const zip = s => new Uint8Array([0x50, 0x4B, 0x03, 0x04, ...enc(s)]);
  assert.equal(sniffExt(zip('\0\0\0mimetypeapplication/epub+zip')), 'epub');
  assert.equal(sniffExt(zip('[Content_Types].xml word/document.xml')), 'docx');
  assert.equal(sniffExt(zip('notes/readme.md img/a.png')), 'zip');
  assert.equal(sniffExt(zip('001.jpg 002.jpg')), 'cbz');
  assert.equal(sniffExt(enc('<?xml version="1.0"?><FictionBook>')), 'fb2');
  assert.equal(sniffExt(enc('  <!DOCTYPE html><html>')), 'html');
  assert.equal(sniffExt(enc('just text')), null);
});

test('extForMime：纯文本按 Markdown', () => {
  assert.equal(extForMime('text/plain;charset=utf-8'), 'md');
  assert.equal(extForMime('application/pdf'), 'pdf');
  assert.equal(extForMime('application/epub+zip'), 'epub');
  assert.equal(extForMime('image/png'), null);
});

test('titleFromText 取标题或首行', () => {
  assert.equal(titleFromText('\n\n# 微积分 *手记*\n正文'), '微积分 手记');
  assert.equal(titleFromText('第一行 [链接](http://x)\n第二行'), '第一行 链接');
  assert.equal(titleFromText('- 列表项\n'), '列表项');
  assert.equal(titleFromText('甲'.repeat(60)), '甲'.repeat(40) + '…');
  assert.equal(titleFromText('   \n---\n', now), '粘贴 2026-11-26 0905');
});

test('textToFile 生成 .md 并保留原文', async () => {
  const f = textToFile('# A/B: 测试\n$x$', now);
  assert.equal(f.name, 'A_B_ 测试.md');
  assert.equal(f.type, 'text/markdown');
  assert.equal(await f.text(), '# A/B: 测试\n$x$');
});

test('asBookFile 给无名 blob 补扩展名，图片返回 null', async () => {
  const pdf = await asBookFile(new File([enc('%PDF-1.4 x')], 'blob', { type: '' }), now);
  assert.equal(pdf.name.endsWith('.pdf'), true);
  const epub = await asBookFile(new File([enc('x')], '', { type: 'application/epub+zip' }), now);
  assert.match(epub.name, /\.epub$/);
  const txt = await asBookFile(new File(['# 标题\n正文'], '', { type: 'text/plain' }), now);
  assert.equal(txt.name, '标题.md');
  assert.equal(await asBookFile(new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], 'image.png', { type: 'image/png' })), null);
  const keep = new File(['x'], 'a.txt');
  assert.equal(await asBookFile(keep), keep);
});
