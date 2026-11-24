// 书籍摘要：取书中第一段正文。服务器已为大多数格式算好（书目里的 summary）；
// 这里为服务器读不了的格式（旧版 .doc、HUFF 压缩的 MOBI 等）和仅在本机的书补算。挑段规则与 server/build-catalog.mjs 一致。
import { store, api } from './store.js';
import { openFlowBook } from './formats.js';

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
const htmlParas = html => html
  .replace(/<(script|style|head|title|rt|rp)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .split(/<\/?(?:p|div|h[1-6]|li|br|blockquote|tr|td|th|section|article|aside|header|footer|dd|dt|table|ul|ol|figure|figcaption|hr)\b[^>]*>/i)
  .map(s => norm(decodeEnt(s.replace(/<[^>]+>/g, ''))))
  .filter(Boolean);
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

// 排版好的行（PDF 文字层）→ 段落：短而不带标点的行是标题、目录、页眉，单独成段；
// 行尾是句末标点且明显短于整页行宽时，段落结束。与 server/build-catalog.mjs 的 lineParas 一致
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
function pdfPageParas(items) {
  const lines = []; let line = '';
  for (const it of items) { line += it.str; if (it.hasEOL) { lines.push(line); line = ''; } }
  if (line.trim()) lines.push(line);
  return lineParas(lines);
}

async function pdfSummary(b, blob) {
  const { PdfDoc } = await import('./pdfdoc.js');
  const pdf = blob ? await PdfDoc.open({ data: new Uint8Array(await blob.arrayBuffer()) }) : await PdfDoc.open({ url: api.fileUrl(b.id) });
  try {
    const seen = [];
    for (let i = 0; i < Math.min(pdf.n, 30); i++) {
      const paras = pdfPageParas((await (await pdf.page(i)).getTextContent()).items);
      const hit = pick(paras); if (hit) return hit;
      seen.push(...paras);
    }
    return pickLoose(seen);
  } finally { pdf.destroy(); }
}

// 返回摘要；'' 表示书里没找到合适的段落（如扫描版）
export async function extractSummary(b) {
  let blob = b.local ? await store.localFile(b.id) : null;
  if (b.format === 'pdf') return pdfSummary(b, blob);
  if (!blob) {
    const r = await fetch(api.fileUrl(b.id), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('取书失败');
    blob = await r.blob();
  }
  const fb = await openFlowBook(blob, { name: b.name || b.path || `book.${b.format}`, format: b.format, title: b.title });
  try {
    const seen = [];
    for (const s of fb.sections.slice(0, 60)) {
      const paras = htmlParas(await s.load());
      const hit = pick(paras); if (hit) return hit;
      seen.push(...paras);
    }
    return pickLoose(seen);
  } finally { fb.destroy?.(); }
}
