import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOf, metaFromName, decodeText, plainToBook, ACCEPT } from '../app/js/formats.js';

test('formatOf 按扩展名识别格式', () => {
  assert.equal(formatOf('a.PDF'), 'pdf');
  assert.equal(formatOf('书.azw3'), 'mobi');
  assert.equal(formatOf('x.fb2.zip'), 'fb2');
  assert.equal(formatOf('notes.markdown'), 'md');
  assert.equal(formatOf('pack.zip'), 'md');
  assert.equal(formatOf('image.png'), null);
  assert.equal(formatOf(''), null);
  assert.ok(ACCEPT.includes('.epub'));
});

test('metaFromName 拆出书名与作者', () => {
  assert.deepEqual(metaFromName('三体 - 刘慈欣.epub'), { title: '三体', author: '刘慈欣' });
  assert.deepEqual(metaFromName('活着（余华 著）.pdf'), { title: '活着', author: '余华' });
  assert.equal(metaFromName('Book (Z-Library).pdf').title, 'Book');
  assert.equal(metaFromName('【红楼梦】.txt').title, '红楼梦');
  assert.equal(metaFromName('report-2024.pdf').author, '');
});

test('decodeText 识别 BOM、UTF-16 与 GB18030', () => {
  const s = '知白书房';
  assert.equal(decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(s)])), s);
  assert.equal(decodeText(new TextEncoder().encode(s)), s);
  const le = new Uint8Array([0xFF, 0xFE, ...new Uint8Array(new Uint16Array([...s].map(c => c.charCodeAt(0))).buffer)]);
  assert.equal(decodeText(le), s);
  // 「中文」的 GBK 编码
  assert.equal(decodeText(new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4])), '中文');
});

test('plainToBook 按章节标题切分并生成目录', () => {
  const body = '这是正文的一段话，内容足够长。'.repeat(3);
  const text = ['第一章 起', body, body, '第二章 承', body, '第三章 转', body, '第四章 合', body].join('\n');
  const book = plainToBook(text, '测试');
  assert.equal(book.kind, 'flow');
  assert.deepEqual(book.toc.map(t => t.label), ['第一章 起', '第二章 承', '第三章 转', '第四章 合']);
  assert.equal(book.sections.length, 4);
});

test('plainToBook 转义 HTML', async () => {
  const book = plainToBook('<script>alert(1)</script>', 't');
  const html = await book.sections[0].load();
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
