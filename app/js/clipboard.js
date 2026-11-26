// 从粘贴板导入：复制的文件或二进制（PDF、EPUB、MOBI…）按原格式导入；纯文本当作 Markdown 成书。
// 纯函数（sniffExt / extForMime / titleFromText / textToFile）不碰 DOM，便于在 Node 里测试。
import { formatOf } from './formats.js';

const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/x-mobipocket-ebook': 'mobi',
  'application/vnd.amazon.ebook': 'azw3',
  'application/vnd.amazon.mobi8-ebook': 'azw3',
  'application/x-fictionbook+xml': 'fb2',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.comicbook+zip': 'cbz',
  'application/x-cbz': 'cbz',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/html': 'html',
  'application/xhtml+xml': 'xhtml',
  'text/plain': 'md', // 纯文本一律按 Markdown 导入
};
export const extForMime = (type = '') => MIME_EXT[type.split(';')[0].trim().toLowerCase()] || null;

const ascii = (u8, from, to) => String.fromCharCode(...u8.subarray(from, to));
const latin = (u8, n = 4096) => new TextDecoder('latin1').decode(u8.subarray(0, n));

// 按文件头判断格式；认不出时返回 null
export function sniffExt(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 4) return null;
  if (ascii(u8, 0, 5) === '%PDF-') return 'pdf';
  if (u8.length >= 68 && ascii(u8, 60, 68) === 'BOOKMOBI') return 'mobi';
  if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return 'doc';
  if (u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04) {
    const head = latin(u8, 65536);
    if (head.includes('mimetypeapplication/epub+zip')) return 'epub';
    if (head.includes('word/document.xml') || head.includes('[Content_Types].xml') && head.includes('word/')) return 'docx';
    if (/\.fb2/i.test(head) && !/\.(md|markdown)/i.test(head)) return 'fbz';
    if (/\.(jpe?g|png|webp|gif)/i.test(head) && !/\.(md|markdown)/i.test(head)) return 'cbz';
    return 'zip';
  }
  const text = latin(u8, 2048).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart().toLowerCase();
  if (text.startsWith('<?xml') && text.includes('<fictionbook')) return 'fb2';
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'html';
  return null;
}

// 文本的书名：首个 Markdown 标题，否则第一行有字的内容
export function titleFromText(text, now = new Date()) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const head = lines.find(l => /^#{1,6}\s+\S/.test(l)) || lines.find(l => /\p{L}|\p{N}/u.test(l)) || '';
  let t = head.replace(/^#{1,6}\s+/, '').replace(/^>\s*|^[-*+]\s+|^\d+[.)]\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~$\\]/g, '').replace(/\s+/g, ' ').trim();
  if ([...t].length > 40) t = [...t].slice(0, 40).join('') + '…';
  if (!t) {
    const p = n => String(n).padStart(2, '0');
    t = `粘贴 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
  }
  return t;
}
const safeName = s => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120) || '粘贴';

// 纯文本 → .md 文件
export function textToFile(text, now = new Date()) {
  return new File([text], safeName(titleFromText(text, now)) + '.md', { type: 'text/markdown', lastModified: now.getTime() });
}

// 给没有可识别扩展名的文件补上扩展名（粘贴板里的 blob 常叫 image.png、blob 或干脆没名字）；不是书则返回 null
export async function asBookFile(file, now = new Date()) {
  if (formatOf(file.name)) return file;
  let ext = extForMime(file.type);
  if (!ext || ext === 'md' || ext === 'zip') ext = sniffExt(new Uint8Array(await file.slice(0, 65536).arrayBuffer())) || ext;
  if (!ext) return null;
  if (ext === 'md' && /^text\/plain/i.test(file.type || '')) return textToFile(await file.text(), now);
  const base = file.name && file.name !== 'blob' ? file.name.replace(/\.[^.]*$/, '') : safeName(titleFromText('', now));
  return new File([file], `${base}.${ext}`, { type: file.type, lastModified: file.lastModified || now.getTime() });
}

const bad = { images: 0, other: 0 };
function note(type) { if (/^image\//.test(type)) bad.images++; else bad.other++; }

// paste 事件里的 DataTransfer：优先文件；只有文字时按 Markdown
export async function fromDataTransfer(dt) {
  bad.images = bad.other = 0;
  const out = [];
  for (const f of dt.files || []) { const b = await asBookFile(f); if (b) out.push(b); else note(f.type); }
  if (!out.length && !dt.files?.length) {
    const text = dt.getData('text/plain');
    if (text && text.trim()) out.push(textToFile(text));
    else {
      const html = dt.getData('text/html');
      if (html && html.trim()) out.push(new File([html], safeName(titleFromText(html.replace(/<[^>]+>/g, ' '))) + '.html', { type: 'text/html' }));
    }
  }
  return { files: out, ...bad };
}

// 异步剪贴板 API（点按钮时）；浏览器不支持或用户拒绝时抛错，由调用方改用粘贴框
export async function fromClipboard() {
  bad.images = bad.other = 0;
  if (!navigator.clipboard?.read) {
    const text = await navigator.clipboard?.readText?.();
    if (text == null) throw new Error('unsupported');
    return { files: text.trim() ? [textToFile(text)] : [], ...bad };
  }
  const items = await navigator.clipboard.read();
  const files = [];
  let text = '', html = '';
  for (const item of items) {
    const types = item.types;
    const bin = types.find(t => !/^text\/(plain|html|uri-list)$/i.test(t) && !/^web /i.test(t) && !/^image\//i.test(t));
    if (bin) {
      const blob = await item.getType(bin);
      const f = await asBookFile(new File([blob], '', { type: bin }));
      if (f) { files.push(f); continue; }
      note(bin);
    } else if (types.some(t => /^image\//i.test(t))) note('image/');
    if (types.includes('text/plain')) text += (text ? '\n\n' : '') + await (await item.getType('text/plain')).text();
    else if (types.includes('text/html')) html += await (await item.getType('text/html')).text();
  }
  if (!files.length) {
    if (text.trim()) files.push(textToFile(text));
    else if (html.trim()) files.push(new File([html], safeName(titleFromText(html.replace(/<[^>]+>/g, ' '))) + '.html', { type: 'text/html' }));
  }
  return { files, ...bad };
}
