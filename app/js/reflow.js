// PDF 文字重排：按文字层重建行、段、章，交给流式排版——字号、行距、页边从此随读者
import { esc } from './util.js';
import { db } from './db.js';

const VERSION = 1;
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const END = /[。！？!?…」』”"）)：:；;]$|[^\d.]\.$/;
const PAGE_NO = /^[\s\d\-–—·.,第页頁ivxlcIVXLC()（）]+$/;

// 原页 → 重排，进度按页互通
export async function pdfToBook(pdf, meta, onProgress) {
  const key = 'reflow:' + meta.id;
  let data = await db.get('kv', key).catch(() => null);
  if (!data || data.v !== VERSION || data.n !== pdf.n) {
    data = await extract(pdf, onProgress);
    db.put('kv', key, data).catch(() => {});
  }
  const book = {
    kind: 'flow', reflow: true, pdf, title: meta.title, author: meta.author || '',
    sections: data.sections.map(s => ({ title: s.title, size: s.html.length, load: async () => s.html })),
    toc: data.toc, resolveLink: async () => null, getCover: async () => null,
    destroy() { book.pdf?.destroy(); },
    // 重排中的位置 → 原书页码（取该章已载入模板里的页标记）
    pageAt(doc, { s, o }) {
      const sec = data.sections[s]; if (!sec) return 0;
      const anchors = doc.tpls.get(s)?.anchors || {};
      let page = sec.p0;
      for (const [k, off] of Object.entries(anchors)) { const p = +k.slice(1); if (off <= o + 1 && p > page) page = p; }
      return page;
    },
    async anchorOfPage(doc, page) {
      let s = data.sections.findIndex(x => page >= x.p0 && page <= x.p1);
      if (s < 0) s = page < data.sections[0].p0 ? 0 : data.sections.length - 1;
      const pages = data.sections[s].pages;
      let p = -1; for (const x of pages) if (x <= page) p = x;
      return p < 0 ? { s, o: 0 } : doc.anchorOfToc({ s, key: 'p' + p });
    },
  };
  return book;
}

async function extract(pdf, onProgress) {
  const n = pdf.n;
  const outline = await pdf.toc();
  // 章：取目录最高一级；没有目录就每十页一章
  const minLevel = Math.min(...outline.map(e => e.level));
  const tops = outline.filter(e => e.level === minLevel);
  let starts = [...new Set(tops.map(e => e.page))].filter(p => p >= 0 && p < n).sort((a, b) => a - b);
  const titled = new Map(); for (const e of tops) if (!titled.has(e.page)) titled.set(e.page, e.label);
  if (starts.length < 2) { starts = []; for (let p = 0; p < n; p += 10) starts.push(p); titled.clear(); }
  if (starts[0] !== 0) starts.unshift(0);

  const sections = [];
  let open = null; // 跨页未完的段落
  for (let k = 0; k < starts.length; k++) {
    const p0 = starts[k], p1 = (starts[k + 1] ?? n) - 1, title = titled.get(p0) || '';
    const blocks = [], pages = [];
    if (title) blocks.push({ h: 2, parts: [title], chap: true });
    open = null;
    for (let p = p0; p <= p1; p++) {
      const page = await pdf.page(p);
      const tc = await page.getTextContent().catch(() => ({ items: [] }));
      const H = page.view[3] - page.view[1];
      const paras = pageBlocks(lines(tc.items), H);
      onProgress?.((p + 1) / n);
      if (!paras.length) continue;
      pages.push(p);
      const mark = { mark: 'p' + p };
      let first = true;
      for (const b of paras) {
        if (first && title && p === p0 && b.h && same(b.text, title)) { blocks[0].parts.unshift(mark); first = false; continue; }
        if (first && b.cont && open) { open.parts.push(...joinPart(open.last, b.text, mark)); open.last = b.text; }
        else {
          const blk = { h: b.h, parts: [b.text], last: b.text };
          if (first) blk.parts.unshift(mark);
          blocks.push(blk);
        }
        first = false;
      }
      const last = blocks[blocks.length - 1];
      open = paras[paras.length - 1].open && !last.h ? last : null;
      if (p % 8 === 7) await new Promise(r => setTimeout(r, 0));
    }
    sections.push({ title, p0, p1, pages, html: blocks.map(render).join('') });
  }
  // 子目录：落到所在页的页标记
  const toc = [];
  for (const e of outline) {
    const s = sections.findIndex(x => e.page >= x.p0 && e.page <= x.p1); if (s < 0) continue;
    if (e.level === minLevel && titled.get(sections[s].p0) === e.label && sections[s].p0 === e.page) toc.push({ label: e.label, level: 1, s });
    else { const pg = sections[s].pages.filter(x => x <= e.page).pop(); toc.push({ label: e.label, level: Math.min(e.level - minLevel + 1, 3), s, key: pg != null ? 'p' + pg : undefined }); }
  }
  return { v: VERSION, n, sections, toc };
}

function same(a, b) { const f = x => x.replace(/[\s·.:：、第章节]/g, '').toLowerCase(); const x = f(a), y = f(b); return !!x && !!y && (x.includes(y) || y.includes(x)); }

function render(b) {
  const inner = b.parts.map(x => typeof x === 'string' ? esc(x) : `<span data-zb-anchor="${x.mark}"></span>`).join('');
  if (b.h) return b.chap ? `<h2 class="chap">${inner}</h2>` : `<h3>${inner}</h3>`;
  return `<p>${inner}</p>`;
}

function joinPart(a, b, mark) {
  if (/[a-z]-$/i.test(a) && /^[a-z]/.test(b)) return [mark, b]; // 断词：连字符留在上一页，读起来几乎无碍
  return CJK.test(a.slice(-1)) || CJK.test(b[0]) ? [mark, b] : [' ', mark, b];
}
function join(a, b) {
  if (/[a-z]-$/i.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return CJK.test(a.slice(-1)) || CJK.test(b[0]) ? a + b : a + ' ' + b;
}

// 文字块 → 行（同一基线、左右相接）
function lines(items) {
  const out = []; let cur = null;
  for (const it of items) {
    const s = it.str;
    if (!s) { if (it.hasEOL && cur) cur.eol = true; continue; }
    const [, b, c, d, x, y] = it.transform;
    if (Math.abs(b) > Math.abs(d) * .5) continue; // 竖排、旋转的文字略过
    const size = Math.hypot(c, d) || it.height || 10;
    if (cur && !cur.eol && Math.abs(y - cur.y) < size * .55 && x > cur.x1 - size * .6) {
      if (x - cur.x1 > size * .22 && !/\s$/.test(cur.text) && !/^\s/.test(s) && !(CJK.test(cur.text.slice(-1)) && CJK.test(s[0]))) cur.text += ' ';
      cur.text += s; cur.x1 = Math.max(cur.x1, x + it.width); cur.size = Math.max(cur.size, size);
    } else {
      if (cur) out.push(cur);
      cur = { text: s, x0: x, x1: x + it.width, y, size };
    }
    if (it.hasEOL) cur.eol = true;
  }
  if (cur) out.push(cur);
  for (const l of out) l.text = l.text.replace(/\s+/g, ' ').trim();
  return out.filter(l => l.text);
}

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

// 行 → 段：缩进、上一行提前收尾、行距骤增都意味着新段；字号明显大且短的是小标题
function pageBlocks(ls, H) {
  ls = ls.filter((l, i) => {
    const edge = l.y > H * .92 || l.y < H * .07;
    if (!edge) return true;
    return !(PAGE_NO.test(l.text) || (l.text.length < 36 && (i === 0 || i === ls.length - 1)));
  });
  if (!ls.length) return [];
  const med = median(ls.map(l => l.size)) || 10;
  const body = ls.filter(l => Math.abs(l.size - med) < med * .15);
  const left = pct(body.map(l => l.x0), .1), right = pct(body.map(l => l.x1), .9);
  const gaps = []; for (let i = 1; i < ls.length; i++) { const g = ls[i - 1].y - ls[i].y; if (g > 0 && g < med * 4) gaps.push(g); }
  const lead = median(gaps) || med * 1.5;
  const isHead = l => l.size > med * 1.18 && l.text.length < 60;
  const out = [];
  let cur = null;
  ls.forEach((l, i) => {
    const prev = ls[i - 1];
    if (isHead(l)) {
      if (cur?.h && prev && isHead(prev) && Math.abs(prev.size - l.size) < 1) { cur.text = join(cur.text, l.text); return; }
      cur = { h: 3, text: l.text }; out.push(cur); return;
    }
    const indent = l.x0 > left + med * 1.1;
    let brk = !cur || cur.h || indent;
    if (!brk && prev) {
      const short = prev.x1 < right - med * 1.6;
      const gap = prev.y - l.y > lead * 1.55 || prev.y - l.y < -med;
      brk = gap || (short && END.test(prev.text)) || (short && prev.x1 < right - (right - left) * .3);
    }
    if (brk) { cur = { text: l.text, cont: i === 0 && !indent }; out.push(cur); }
    else cur.text = join(cur.text, l.text);
  });
  const last = ls[ls.length - 1];
  if (cur && !cur.h) cur.open = last.x1 >= right - med * 1.6 && !END.test(last.text);
  return out;
}
