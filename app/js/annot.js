// PDF 批注：读出文件自带的高亮与批注、在原页面上划线、把笔记写回 PDF 供下载
import { h, uid } from './util.js';

// 四色划线在 PDF 里的颜色（正片叠底下仍透出字迹）
export const PDF_RGB = { y: [1, .86, .36], g: [.58, .85, .66], b: [.62, .77, 1], r: [1, .62, .62] };
const MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
const DRAWING = new Set(['Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine']);
const KNOWN = new Set([...MARKUP, ...DRAWING, 'Text', 'FreeText']);

export const isPdfNote = n => n.kind === 'pdf';
// PDF 坐标 ↔ 页面坐标（scale 1 的视口矩阵，含页面旋转）
const toView = (vp, x, y) => { const [a, b, c, d, e, f] = vp.transform; return [a * x + c * y + e, b * x + d * y + f]; };
const toPdf = (vp, x, y) => { const [a, b, c, d, e, f] = vp.transform, k = a * d - b * c; return [(d * (x - e) - c * (y - f)) / k, (a * (y - f) - b * (x - e)) / k]; };
export const visible = n => !n.del;

// 最接近的命名颜色，便于在阅读器里统一改色
function nearest(rgb) {
  if (!rgb) return 'y';
  let best = 'y', d = Infinity;
  for (const [k, c] of Object.entries(PDF_RGB)) { const e = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2; if (e < d) { d = e; best = k; } }
  return best;
}
const toRgb = c => c && c.length >= 3 ? [...c].slice(0, 3).map(v => v > 1 ? v / 255 : v) : null;
const flat = q => q ? (q.length && typeof q[0] === 'object' ? [...q].flatMap(p => p.x != null ? [p.x, p.y] : [...p]) : [...q]) : [];
function pdfDate(s) {
  const m = /D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  return m ? Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0) : 0;
}

// ---------- 读取 ----------
export async function pageAnnots(doc, i) {
  const page = await doc.page(i);
  const list = await page.getAnnotations({ intent: 'display' }).catch(() => []);
  return list.filter(a => KNOWN.has(a.subtype) && !a.hidden);
}
export const hasMarkup = list => list.some(a => KNOWN.has(a.subtype));

// 把一页的批注转成阅读器的笔记
export async function importPage(doc, i, list) {
  if (!list.length) return [];
  const items = (await (await doc.page(i)).getTextContent().catch(() => ({ items: [] }))).items;
  return list.map(a => {
    const rgb = toRgb(a.color);
    const n = {
      id: 'pdf:' + a.id, aid: a.id, src: 'pdf', kind: 'pdf', type: a.subtype, page: i,
      color: nearest(rgb), rgb, note: a.contentsObj?.str || '', by: a.titleObj?.str || '',
      t: pdfDate(a.modificationDate) || pdfDate(a.creationDate) || 0, label: `第 ${i + 1} 页`, rect: a.rect ? [...a.rect] : null,
    };
    if (MARKUP.has(a.subtype)) {
      const q = flat(a.quadPoints); n.quads = [];
      for (let k = 0; k + 7 < q.length; k += 8) n.quads.push(q.slice(k, k + 8));
      if (!n.quads.length && n.rect) n.quads.push(rectQuad(n.rect));
      n.text = textInQuads(items, n.quads);
    } else if (a.subtype === 'Ink') n.ink = (a.inkLists || []).map(flat);
    else if (a.subtype === 'FreeText') n.text = '';
    n.text = n.text || '';
    return n;
  });
}
const rectQuad = ([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0];

// 高亮框里压着的文字（按字符比例截取，覆盖半行也能取准）
function textInQuads(items, quads) {
  const out = [];
  for (const q of quads) {
    const qx0 = Math.min(q[0], q[4]), qx1 = Math.max(q[2], q[6]), qy0 = Math.min(q[5], q[7]), qy1 = Math.max(q[1], q[3]);
    let line = '';
    for (const it of items) {
      if (!it.str) continue;
      const x = it.transform[4], y = it.transform[5], w = it.width || 0, hh = it.height || Math.hypot(it.transform[2], it.transform[3]);
      const cy = y + hh * .4;
      if (cy < qy0 || cy > qy1 || x > qx1 || x + w < qx0 || !w) continue;
      const a = Math.max(0, (qx0 - x) / w), b = Math.min(1, (qx1 - x) / w);
      const n = it.str.length;
      line += it.str.slice(Math.round(a * n), Math.max(Math.round(a * n) + 1, Math.round(b * n)));
    }
    if (line.trim()) out.push(line.trim());
  }
  return tidy(out.join('\n'));
}
export const tidy = s => s.replace(/([　-鿿＀-￯])\s+(?=[　-鿿＀-￯])/g, '$1').replace(/[ \t]+/g, ' ').trim();

// 合并新扫描到的批注：同一条批注（aid）保留读者的改动与删除
export function mergeImported(notes, imported) {
  const have = new Set(notes.filter(n => n.aid).map(n => n.aid));
  const add = imported.filter(n => !have.has(n.aid));
  return add.length ? [...notes, ...add] : null;
}

// ---------- 选区 → 高亮四边形（PDF 坐标） ----------
export function selectionQuads(range, layer, vp1) {
  const lr = layer.getBoundingClientRect();
  if (!lr.width || !lr.height) return [];
  const rects = [...range.getClientRects()].filter(r => r.width > .5 && r.height > .5 && r.right > lr.left && r.left < lr.right && r.bottom > lr.top && r.top < lr.bottom);
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const r of rects) {
    const cy = (r.top + r.bottom) / 2;
    const l = lines.find(l => Math.abs((l.top + l.bottom) / 2 - cy) < Math.min(l.bottom - l.top, r.height) * .55);
    if (l) { l.left = Math.min(l.left, r.left); l.right = Math.max(l.right, r.right); l.top = Math.min(l.top, r.top); l.bottom = Math.max(l.bottom, r.bottom); }
    else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  const fx = x => (Math.min(Math.max(x, lr.left), lr.right) - lr.left) / lr.width * vp1.width;
  const fy = y => (Math.min(Math.max(y, lr.top), lr.bottom) - lr.top) / lr.height * vp1.height;
  return lines.map(l => {
    const [ax, ay] = toPdf(vp1, fx(l.left), fy(l.bottom)), [bx, by] = toPdf(vp1, fx(l.right), fy(l.top));
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    return [x0, y1, x1, y1, x0, y0, x1, y0].map(v => Math.round(v * 100) / 100);
  });
}

// ---------- 绘制：叠在页面上的一层，按整页百分比定位，缩放不走样 ----------
export function drawNotes(box, i, notes, vp1) {
  box.replaceChildren();
  if (!vp1) return;
  const W = vp1.width, H = vp1.height;
  const pct = ([x0, y0, x1, y1]) => {
    const [a, b] = toView(vp1, x0, y0), [c, d] = toView(vp1, x1, y1);
    const l = Math.min(a, c), t = Math.min(b, d);
    return { left: l / W * 100 + '%', top: t / H * 100 + '%', width: Math.abs(c - a) / W * 100 + '%', height: Math.abs(d - b) / H * 100 + '%' };
  };
  for (const n of notes) {
    if (n.page !== i || n.del || n.kind !== 'pdf') continue;
    const cls = 'c-' + (n.color || 'y');
    const style = n.rgb && !n.recolored ? { '--ann': `rgb(${n.rgb.map(v => Math.round(v * 255)).join(',')})` } : null;
    if (n.quads) {
      const kind = n.type === 'Underline' ? 'u' : n.type === 'StrikeOut' ? 's' : n.type === 'Squiggly' ? 'w' : 'hl';
      n.quads.forEach((q, k) => {
        const el = h('i', { class: `ann-q ${kind} ${cls}` + (n.note && k === n.quads.length - 1 ? ' has-note' : ''), dataset: { id: n.id } });
        Object.assign(el.style, pct([Math.min(q[0], q[4]), Math.min(q[5], q[7]), Math.max(q[2], q[6]), Math.max(q[1], q[3])]), style || {});
        box.append(el);
      });
    } else if (n.type === 'Text' && n.rect) {
      const [x0, , , y1] = n.rect;
      const el = h('i', { class: `ann-pin ${cls}`, dataset: { id: n.id }, title: n.note || '' });
      const [px, py] = toView(vp1, x0, y1);
      Object.assign(el.style, { left: px / W * 100 + '%', top: py / H * 100 + '%' }, style || {});
      box.append(el);
    } else if (n.rect) {
      const el = h('i', { class: `ann-box ${n.type === 'FreeText' ? 'ft' : 'dr'} ${cls}`, dataset: { id: n.id } });
      Object.assign(el.style, pct(n.rect), style || {});
      if (n.type === 'Ink' && n.ink?.length) {
        const [x0, y0, x1, y1] = n.rect;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `${x0} ${-y1} ${x1 - x0 || 1} ${y1 - y0 || 1}`); svg.setAttribute('preserveAspectRatio', 'none');
        for (const pts of n.ink) {
          const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          const xy = []; for (let k = 0; k + 1 < pts.length; k += 2) xy.push(`${pts[k]},${-pts[k + 1]}`);
          p.setAttribute('points', xy.join(' ')); svg.append(p);
        }
        el.append(svg); el.classList.add('ink');
      }
      box.append(el);
    }
  }
}

// ---------- 写回 PDF ----------
export async function exportPdf(bytes, notes, { author = '知白' } = {}) {
  const L = await import('../vendor/pdf-lib.esm.min.js');
  const { PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFRef } = L;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context, pages = doc.getPages();
  const date = t => { const d = new Date(t || Date.now()), p = x => String(x).padStart(2, '0'); return PDFString.of(`D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`); };
  const text = s => PDFHexString.fromText(s || '');
  const refOf = aid => { const m = /^(\d+)R(\d*)$/.exec(aid || ''); return m ? PDFRef.of(+m[1], +(m[2] || 0)) : null; };
  const annotsOf = page => { let a = page.node.lookup(PDFName.of('Annots')); if (!(a instanceof PDFArray)) { a = ctx.obj([]); page.node.set(PDFName.of('Annots'), a); } return a; };
  const removeRef = (page, ref) => {
    const arr = annotsOf(page);
    for (let k = arr.size() - 1; k >= 0; k--) { const r = arr.get(k); if (r instanceof PDFRef && r.objectNumber === ref.objectNumber && r.generationNumber === ref.generationNumber) arr.remove(k); }
  };
  const appearance = (rect, quads, rgb) => {
    const ops = [`/GS0 gs ${rgb.map(v => v.toFixed(3)).join(' ')} rg`];
    for (const q of quads) ops.push(`${q[4]} ${q[5]} m ${q[6]} ${q[7]} l ${q[2]} ${q[3]} l ${q[0]} ${q[1]} l h f`);
    const stream = ctx.stream(ops.join('\n'), {
      Type: 'XObject', Subtype: 'Form', BBox: rect, Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } },
    });
    return ctx.register(stream);
  };
  const bbox = quads => { const xs = quads.flatMap(q => [q[0], q[2], q[4], q[6]]), ys = quads.flatMap(q => [q[1], q[3], q[5], q[7]]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  let added = 0, changed = 0, removed = 0;
  for (const n of notes) {
    if (n.kind !== 'pdf' || n.page == null || !pages[n.page]) continue;
    const page = pages[n.page];
    if (n.aid) { // 文件里原有的批注
      const ref = refOf(n.aid); if (!ref) continue;
      const dict = ctx.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      if (n.del) { const pop = dict.get(PDFName.of('Popup')); removeRef(page, ref); if (pop instanceof PDFRef) removeRef(page, pop); removed++; continue; }
      if (!n.edited) continue;
      dict.set(PDFName.of('Contents'), text(n.note));
      dict.set(PDFName.of('M'), date(n.t));
      if (n.recolored) {
        const rgb = PDF_RGB[n.color] || PDF_RGB.y;
        dict.set(PDFName.of('C'), ctx.obj(rgb));
        if (n.quads?.length && n.type === 'Highlight') dict.set(PDFName.of('AP'), ctx.obj({ N: appearance(bbox(n.quads), n.quads, rgb) }));
        else dict.delete(PDFName.of('AP'));
      }
      changed++; continue;
    }
    if (n.del || !n.quads?.length) continue;
    const rgb = PDF_RGB[n.color] || PDF_RGB.y, rect = bbox(n.quads);
    const annot = ctx.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: rect, QuadPoints: n.quads.flat(), C: rgb, F: 4, P: page.ref,
      Contents: text(n.note), T: text(author), NM: PDFString.of(n.id || uid()), M: date(n.t), CreationDate: date(n.t),
      AP: { N: appearance(rect, n.quads, rgb) },
    });
    annotsOf(page).push(ctx.register(annot));
    added++;
  }
  const out = await doc.save({ useObjectStreams: false });
  return { blob: new Blob([out], { type: 'application/pdf' }), added, changed, removed };
}
