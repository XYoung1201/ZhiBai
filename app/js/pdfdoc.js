// PDF：pdf.js 分段加载（Range），按需渲染，智能裁白边，文字层可选中，书内搜索；翻页与滚动两种视图
import { h, clamp } from './util.js';
import { pageAnnots, importPage, drawNotes } from './annot.js';

let pdfjsP;
const abs = p => new URL(p, location.href).href;
export function loadPdfjs() {
  return pdfjsP || (pdfjsP = import('../vendor/pdfjs/pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = abs('vendor/pdfjs/pdf.worker.min.mjs');
    return m;
  }));
}
const MAX_PX = (navigator.deviceMemory && navigator.deviceMemory <= 4) || /iP(hone|ad)/.test(navigator.userAgent) ? 4.2e6 : 7e6;

export class PdfDoc {
  kind = 'pdf';
  static async open(source, { onProgress } = {}) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      ...(source.url ? { url: source.url, withCredentials: true } : { data: source.data }),
      cMapUrl: abs('vendor/pdfjs/cmaps/'), cMapPacked: true,
      standardFontDataUrl: abs('vendor/pdfjs/standard_fonts/'),
      wasmUrl: abs('vendor/pdfjs/wasm/'), iccUrl: abs('vendor/pdfjs/iccs/'),
      rangeChunkSize: 384 * 1024, disableAutoFetch: true, disableStream: true,
      isEvalSupported: false, enableXfa: false,
    });
    if (onProgress) task.onProgress = ({ loaded, total }) => total && onProgress(loaded / total);
    const pdf = await task.promise;
    const d = new PdfDoc(pdf, pdfjs);
    await d.#init();
    return d;
  }
  constructor(pdf, pdfjs) {
    this.pdf = pdf; this.pdfjs = pdfjs; this.n = pdf.numPages;
    this.pages = new Map(); this.sizes = new Map(); this.vps = new Map(); this.anns = new Map(); this.notes = []; this.cache = new Map(); this.thumbs = new Map(); this.texts = new Map();
    this.crop = null; this.renderQ = Promise.resolve();
  }
  async #init() {
    const p1 = await this.page(0);
    const v = p1.getViewport({ scale: 1 });
    this.base = { w: v.width, h: v.height };
    const meta = await this.pdf.getMetadata().catch(() => null);
    this.meta = { title: meta?.info?.Title || '', author: meta?.info?.Author || '' };
  }
  async page(i) {
    if (!this.pages.has(i)) this.pages.set(i, this.pdf.getPage(i + 1).then(p => { const v = p.getViewport({ scale: 1 }); this.sizes.set(i, { w: v.width, h: v.height }); this.vps.set(i, v); return p; }));
    return this.pages.get(i);
  }
  vp1(i) { return this.vps.get(i); }
  // 文件自带的批注（高亮、便签、手绘……）
  annotsOf(i) { if (!this.anns.has(i)) this.anns.set(i, pageAnnots(this, i)); return this.anns.get(i); }
  async scanAnnots(onPage, signal) {
    for (let i = 0; i < this.n; i++) {
      if (signal?.aborted) return;
      const list = await this.annotsOf(i);
      if (list.length) onPage(await importPage(this, i, list));
      if (i % 12 === 11) await new Promise(r => setTimeout(r, 30));
    }
  }
  setNotes(notes, root) {
    this.notes = notes || [];
    if (root) for (const w of root.querySelectorAll('.pdf-page[data-page]')) this.#drawNotes(w, +w.dataset.page);
  }
  // 与文字层同一几何：覆盖整页（含被裁去的白边），子元素按百分比定位
  #fullBox(el, i, css) {
    const crop = this.cropOf(i) || [0, 0, 1, 1], size = this.sizeOf(i);
    Object.assign(el.style, { inset: 'auto', left: -crop[0] * size.w * css + 'px', top: -crop[1] * size.h * css + 'px', width: size.w * css + 'px', height: size.h * css + 'px' });
  }
  #drawNotes(wrap, i) {
    let box = wrap.querySelector('.pdf-ann');
    const mine = this.notes.some(n => n.page === i && n.kind === 'pdf' && !n.del);
    if (!mine) { box?.replaceChildren(); return; }
    if (!box) { box = h('div', { class: 'pdf-ann' }); const tl = wrap.querySelector('.textLayer'); tl ? tl.before(box) : wrap.append(box); }
    this.#fullBox(box, i, +wrap.querySelector('canvas').dataset.css);
    drawNotes(box, i, this.notes, this.vp1(i));
  }
  sizeOf(i) { return this.sizes.get(i) || this.base; }
  cropOf(i) { return this.crop ? (i % 2 ? this.crop.odd : this.crop.even) : null; }
  aspectOf(i) { const s = this.sizeOf(i), c = this.cropOf(i); return c ? (s.w * (c[2] - c[0])) / (s.h * (c[3] - c[1])) : s.w / s.h; }

  // ---------- 目录 ----------
  async toc() {
    const out = [];
    const outline = await this.pdf.getOutline().catch(() => null);
    const walk = async (items, level) => {
      for (const it of items || []) {
        let page = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await this.pdf.getDestination(dest);
          if (Array.isArray(dest)) page = typeof dest[0] === 'number' ? dest[0] : await this.pdf.getPageIndex(dest[0]);
        } catch {}
        if (page != null) out.push({ label: (it.title || '').trim() || '—', level: Math.min(level, 3), page });
        if (it.items?.length && level < 4) await walk(it.items, level + 1);
      }
    };
    await walk(outline, 1);
    return out;
  }

  // ---------- 裁白边：抽样若干页，按奇偶页分别求内容边界 ----------
  async computeCrop() {
    if (this.cropComputed) { this.crop = this.cropComputed; return; }
    const n = this.n, picks = new Set();
    for (const f of [.12, .2, .3, .4, .5, .6, .7, .8, .9]) picks.add(clamp(Math.round(f * (n - 1)), 0, n - 1));
    for (let k = 3; k < Math.min(n, 9); k++) picks.add(k);
    const res = { odd: [], even: [] };
    for (const i of picks) { const b = await this.#contentBox(i); if (b) res[i % 2 ? 'odd' : 'even'].push(b); }
    const agg = arr => {
      if (!arr.length) return null;
      const q = (k, f, lo) => { const v = arr.map(b => b[k]).sort((a, b) => a - b); return lo ? v[Math.floor((v.length - 1) * f)] : v[Math.ceil((v.length - 1) * f)]; };
      const box = [q(0, .15, true), q(1, .15, true), q(2, .85), q(3, .85)];
      const pad = .012;
      box[0] = clamp(box[0] - pad, 0, 1); box[1] = clamp(box[1] - pad, 0, 1); box[2] = clamp(box[2] + pad, 0, 1); box[3] = clamp(box[3] + pad, 0, 1);
      if (box[2] - box[0] < .4 || box[3] - box[1] < .4) return null;
      return box;
    };
    const odd = agg(res.odd) || agg(res.even), even = agg(res.even) || odd;
    this.cropComputed = odd || even ? { odd: odd || even, even: even || odd } : null;
    this.crop = this.cropComputed;
  }
  async #contentBox(i) {
    try {
      const page = await this.page(i);
      const v = page.getViewport({ scale: 1 });
      const scale = 220 / v.width, vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport: vp, background: '#fff' }).promise;
      const { data, width: W, height: H } = ctx.getImageData(0, 0, c.width, c.height);
      const edge = Math.round(W * .02), rowHit = new Uint16Array(H), colHit = new Uint16Array(W);
      for (let y = edge; y < H - edge; y++) for (let x = edge; x < W - edge; x++) {
        const k = (y * W + x) * 4; const l = data[k] * .3 + data[k + 1] * .59 + data[k + 2] * .11;
        if (l < 165) { rowHit[y]++; colHit[x]++; }
      }
      const thr = a => Math.max(2, a * .006);
      let y0 = rowHit.findIndex(v => v > thr(W)), y1 = H - 1 - [...rowHit].reverse().findIndex(v => v > thr(W));
      let x0 = colHit.findIndex(v => v > thr(H)), x1 = W - 1 - [...colHit].reverse().findIndex(v => v > thr(H));
      c.width = 0;
      if (y0 < 0 || x0 < 0) return null;
      return [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H];
    } catch { return null; }
  }

  // ---------- 版式（翻页） ----------
  setLayout(stageW, stageH, s, insets = { top: 0, bottom: 0 }) {
    const a = this.aspectOf(Math.min(2, this.n - 1));
    const phone = stageW < 600;
    const spread = this.n > 1 && (s.spread === 'double' ? stageW >= 600 : s.spread === 'auto' && stageW >= 880 && stageW / stageH > a * 1.55);
    const padX = phone ? 0 : Math.round(clamp(stageW * .025, 12, 36)), padY = phone ? 0 : Math.round(clamp(stageH * .03, 10, 28));
    const top = padY + (phone ? insets.top : 0), bottom = padY + (phone ? insets.bottom : 0);
    const aw = stageW - padX * 2, ah = stageH - top - bottom;
    let rects;
    if (spread) {
      const w = Math.floor(Math.min(aw / 2, ah * a)), hh = Math.floor(w / a);
      const x0 = Math.round((stageW - w * 2) / 2), y = Math.round(top + (ah - hh) / 2);
      rects = [{ x: x0, y, w, h: hh }, { x: x0 + w, y, w, h: hh }];
    } else {
      const w = Math.floor(Math.min(aw, ah * a)), hh = Math.floor(Math.min(ah, w / a));
      rects = [{ x: Math.round((stageW - w) / 2), y: Math.round(top + (ah - hh) / 2), w, h: hh }];
    }
    const key = JSON.stringify([rects, !!this.crop]);
    if (key !== this.layoutKey) { this.layoutKey = key; this.#dropCache(); }
    this.L = { spread, rects };
    return this.L;
  }
  get spread() { return this.L.spread; }
  rects() { return this.L.rects; }
  zoomable = true;

  // 双页：第 0 跨页 = [空, 第1页]，此后 [2k-1, 2k]
  pagesOf(pos) { return this.L.spread ? [2 * pos - 1, 2 * pos] : [pos]; }
  posOf(page) { return this.L.spread ? Math.ceil(page / 2) : page; }
  pageOf(pos) { return this.L.spread ? Math.max(0, 2 * pos - 1) : pos; }
  key(pos) { return String(pos); }
  async step(pos, dir) {
    const np = pos + dir;
    const max = this.L.spread ? Math.ceil((this.n - 1) / 2) : this.n - 1;
    return np < 0 || np > max ? null : np;
  }
  async fill(faces, pos) {
    const pages = this.pagesOf(pos);
    await Promise.all(faces.map((face, k) => this.#fillFace(face, pages[k], 1)));
  }
  renderInto(face, i) { return this.#fillFace(face, i, 1); }
  async refine(faces, zoom) {
    for (const f of faces) if (f.dataset.page != null && f.dataset.page !== '') await this.#fillFace(f, +f.dataset.page, zoom, true);
  }
  async #fillFace(face, i, zoom = 1, keepText = false) {
    face.classList.add('pdf-face');
    face.dataset.page = i >= 0 && i < this.n ? i : '';
    if (!(i >= 0 && i < this.n)) { face.replaceChildren(); face.classList.add('blank'); return; }
    face.classList.remove('blank');
    const fw = parseFloat(face.style.width), fh = parseFloat(face.style.height);
    const canvas = await this.#render(i, fw, fh, zoom);
    const old = face.querySelector('.pdf-page');
    const wrap = h('div', { class: 'pdf-page', dataset: { page: i } });
    wrap.style.width = canvas.style.width; wrap.style.height = canvas.style.height;
    wrap.append(canvas);
    if (keepText && old?.querySelector('.textLayer')) wrap.append(old.querySelector('.textLayer'));
    this.#drawNotes(wrap, i);
    face.replaceChildren(wrap);
  }
  #dropCache() { for (const c of this.cache.values()) c.canvas.width = 0; this.cache.clear(); }
  async #render(i, fw, fh, zoom) {
    const key = `${i}@${fw}x${fh}@${zoom.toFixed(2)}`;
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit.canvas.isConnected ? copyCanvas(hit.canvas) : hit.canvas; }
    const job = this.renderQ.then(async () => {
      const page = await this.page(i);
      // 页上若有批注，由阅读器自己画（才能改色、删除）；否则照文件原样
      const annMode = (await this.annotsOf(i)).length ? this.pdfjs.AnnotationMode.DISABLE : this.pdfjs.AnnotationMode.ENABLE;
      const size = this.sizeOf(i), crop = this.cropOf(i) || [0, 0, 1, 1];
      const cw = size.w * (crop[2] - crop[0]), ch = size.h * (crop[3] - crop[1]);
      const css = Math.min(fw / cw, fh / ch);
      let scale = css * Math.min(devicePixelRatio || 1, 3) * zoom;
      if (cw * ch * scale * scale > MAX_PX * Math.min(zoom, 2)) scale = Math.sqrt(MAX_PX * Math.min(zoom, 2) / (cw * ch));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(cw * scale)); c.height = Math.max(1, Math.round(ch * scale));
      c.style.width = (cw * css).toFixed(2) + 'px'; c.style.height = (ch * css).toFixed(2) + 'px';
      c.dataset.css = css; c.dataset.page = i;
      const ctx = c.getContext('2d', { alpha: false });
      await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -crop[0] * vp.width, -crop[1] * vp.height], background: '#ffffff', annotationMode: annMode }).promise;
      return c;
    });
    this.renderQ = job.catch(() => {});
    const c = await job;
    this.cache.set(key, { canvas: c });
    while (this.cache.size > 10) { const [k, v] = this.cache.entries().next().value; if (!v.canvas.isConnected) v.canvas.width = 0; this.cache.delete(k); }
    return c;
  }
  async textLayer(face) {
    const i = +face.dataset.page; if (!(face.dataset.page !== '' && i >= 0)) return;
    const wrap = face.querySelector('.pdf-page'); if (!wrap || wrap.querySelector('.textLayer')) return;
    const canvas = wrap.querySelector('canvas'); const css = +canvas.dataset.css;
    const page = await this.page(i);
    const crop = this.cropOf(i) || [0, 0, 1, 1], size = this.sizeOf(i);
    const vp = page.getViewport({ scale: css });
    const tl = h('div', { class: 'textLayer' });
    tl.style.setProperty('--total-scale-factor', css); tl.style.setProperty('--scale-factor', css);
    this.#fullBox(tl, i, css);
    wrap.append(tl);
    try { await new this.pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render(); } catch (e) { console.warn(e); }
    this.#fullBox(tl, i, css); // pdf.js 会改写容器尺寸，按我们的几何复位
    if (this.hit?.page === i) markHit(tl, this.hit.q);
  }
  async thumb(i, w = 132) {
    if (this.thumbs.has(i)) return this.thumbs.get(i);
    const p = (async () => {
      const page = await this.page(i);
      const v = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: w * 1.5 / v.width });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      c.style.width = w + 'px';
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#fff' }).promise;
      return c;
    })();
    this.thumbs.set(i, p);
    if (this.thumbs.size > 40) { const [k, v] = this.thumbs.entries().next().value; this.thumbs.delete(k); v.then(c => c.width = 0); }
    return p;
  }

  // ---------- 文本与搜索 ----------
  // 抽几页看看有没有文字层（扫描版没有）
  async textual() {
    if (this.textualKnown != null) return this.textualKnown;
    const picks = [...new Set([3, 8, 15, 30, this.n >> 1].map(p => Math.min(this.n - 1, p)))];
    let chars = 0; for (const p of picks) chars += (await this.pageText(p)).replace(/\s/g, '').length;
    return (this.textualKnown = chars > picks.length * 60);
  }
  async pageText(i) {
    if (!this.texts.has(i)) this.texts.set(i, this.page(i).then(p => p.getTextContent()).then(tc => tc.items.map(it => it.str + (it.hasEOL ? '\n' : '')).join('')).catch(() => ''));
    return this.texts.get(i);
  }
  async search(q, onResult, signal) {
    const ql = q.toLowerCase().replace(/\s+/g, ''); let count = 0, empty = 0;
    for (let i = 0; i < this.n; i++) {
      if (signal?.aborted) return;
      const raw = await this.pageText(i);
      if (!raw.trim()) { if (++empty > 30 && empty === i + 1) { onResult({ scanned: true }); return; } continue; }
      // 忽略空白匹配（PDF 文字常被拆成多段）
      const map = [], flat = [];
      for (let k = 0; k < raw.length; k++) if (!/\s/.test(raw[k])) { map.push(k); flat.push(raw[k]); }
      const fl = flat.join('').toLowerCase();
      let j = fl.indexOf(ql);
      while (j >= 0 && count < 500) {
        const a = map[j], b = map[j + ql.length - 1] + 1;
        onResult({ page: i, title: `第 ${i + 1} 页`, before: raw.slice(Math.max(0, a - 24), a).replace(/\s+/g, ' '), match: raw.slice(a, b), after: raw.slice(b, b + 40).replace(/\s+/g, ' ') });
        count++; j = fl.indexOf(ql, j + ql.length);
      }
    }
  }
  setHit(hit) { this.hit = hit; }
  destroy() { this.#dropCache(); this.pdf.destroy?.(); }
}

function copyCanvas(src) {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  c.style.cssText = src.style.cssText; Object.assign(c.dataset, src.dataset);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
function markHit(tl, q) {
  const ql = q.toLowerCase().replace(/\s+/g, '');
  const spans = [...tl.querySelectorAll('span')];
  let flat = '', owners = [];
  for (const s of spans) for (const ch of s.textContent) if (!/\s/.test(ch)) { flat += ch.toLowerCase(); owners.push(s); }
  let j = flat.indexOf(ql);
  while (j >= 0) { for (let k = j; k < j + ql.length; k++) owners[k].classList.add('hit'); j = flat.indexOf(ql, j + ql.length); }
}

// ---------- 滚动视图 ----------
export class PdfScroll {
  constructor(doc, stage, { onChange, onTap, onZoom } = {}) {
    this.doc = doc; this.cb = { onChange, onTap, onZoom };
    this.el = h('div', { class: 'scroller pdf-scroller' });
    this.inner = h('div', { class: 'scroll-inner' });
    this.el.append(this.inner); stage.append(this.el);
    this.zoom = 1;
    this.io = new IntersectionObserver(es => { for (const e of es) e.isIntersecting ? this.#show(e.target) : this.#hide(e.target); }, { root: this.el, rootMargin: '120% 0px' });
    this.el.addEventListener('scroll', () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.#report()); }, { passive: true });
    let down;
    this.el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    this.el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 600) return;
      const sel = getSelection(); if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      this.cb.onTap?.(0, e);
    });
    this.el.addEventListener('wheel', e => {
      if (!e.ctrlKey) return; e.preventDefault();
      const r = this.el.getBoundingClientRect();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * .01), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    // 双指缩放：手势中只做 CSS 预览，松手后按新宽度重绘，字迹清晰
    let pinch = null;
    const mid = t => { const r = this.el.getBoundingClientRect(); return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) }; };
    this.el.addEventListener('touchstart', e => {
      if (e.touches.length !== 2) return;
      const m = mid(e.touches);
      pinch = { ...m, k: 1, ox: this.el.scrollLeft + m.x, oy: this.el.scrollTop + m.y };
      this.inner.style.transformOrigin = `${pinch.ox}px ${pinch.oy}px`;
    }, { passive: true });
    this.el.addEventListener('touchmove', e => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.k = clamp(mid(e.touches).d / pinch.d, .5 / this.zoom, 4 / this.zoom);
      this.inner.style.transform = `scale(${pinch.k})`;
    }, { passive: false });
    const endPinch = () => {
      if (!pinch) return;
      const { k, x, y } = pinch; pinch = null;
      this.inner.style.transform = ''; this.inner.style.transformOrigin = '';
      if (Math.abs(k - 1) > .03) this.setZoom(this.zoom * k, x, y);
    };
    this.el.addEventListener('touchend', e => { if (e.touches.length < 2) endPinch(); });
    this.el.addEventListener('touchcancel', endPinch);
  }
  get spread() { return false; }
  layout() {
    const W = this.el.clientWidth;
    const base = Math.min(W - (W < 600 ? 0 : 48), 980);
    return Math.round(base * this.zoom);
  }
  async open(page, frac = 0) {
    this.io.disconnect();
    this.inner.replaceChildren();
    const w = this.layout();
    this.pw = w;
    this.cb.onZoom?.(this.zoom);
    const frag = document.createDocumentFragment();
    this.slots = [];
    for (let i = 0; i < this.doc.n; i++) {
      const a = this.doc.aspectOf(i);
      const s = h('div', { class: 'pdf-slot', dataset: { page: i } }, h('span', { class: 'pdf-slot-num' }, i + 1));
      s.style.width = w + 'px'; s.style.height = Math.round(w / a) + 'px';
      frag.append(s); this.slots.push(s);
    }
    this.inner.append(frag);
    this.inner.style.width = Math.max(w, this.el.clientWidth) + 'px';
    for (const s of this.slots) this.io.observe(s);
    const t = this.slots[clamp(page, 0, this.doc.n - 1)];
    this.el.scrollTop = t.offsetTop - 8 + frac * t.offsetHeight;
    this.el.scrollLeft = (this.inner.scrollWidth - this.el.clientWidth) / 2;
    this.#report();
  }
  go(page) { return this.open(page); }
  async #show(slot) {
    if (slot.dataset.shown) return;
    slot.dataset.shown = '1';
    const i = +slot.dataset.page;
    const face = h('div', { class: 'pdf-face' });
    face.style.width = slot.style.width; face.style.height = slot.style.height;
    await this.doc.renderInto(face, i).catch(() => {});
    const wrap = face.querySelector('.pdf-page');
    if (!slot.dataset.shown || !wrap) return;
    slot.querySelector('.pdf-page')?.remove();
    slot.append(wrap);
    const a = this.doc.aspectOf(i); const hh = Math.round(this.pw / a);
    if (Math.abs(parseFloat(slot.style.height) - hh) > 2) slot.style.height = hh + 'px';
    this.doc.textLayer(slot);
  }
  #hide(slot) {
    if (!slot.dataset.shown) return;
    delete slot.dataset.shown;
        slot.querySelector('.pdf-page')?.remove();
  }
  #report() {
    if (!this.slots) return;
    const r = this.el.getBoundingClientRect(), mid = r.top + r.height * .35;
    let lo = 0, hi = this.slots.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.slots[m].getBoundingClientRect().top <= mid) lo = m; else hi = m - 1; }
    const s = this.slots[lo], sr = s.getBoundingClientRect();
    const frac = clamp((r.top - sr.top) / sr.height, 0, 1);
    if (lo !== this.current) { this.current = lo; if (s.dataset.shown) this.doc.textLayer(s); }
    this.cb.onChange?.(lo, frac);
  }
  position() { if (!this.slots) return { page: 0, frac: 0 }; const s = this.slots[this.current || 0], r = this.el.getBoundingClientRect(); return { page: this.current || 0, frac: clamp((r.top - s.getBoundingClientRect().top) / s.offsetHeight, 0, 1) }; }
  // 以 (cx, cy) 为不动点缩放：先拉伸现有页面，稍后按新尺寸重绘
  setZoom(z, cx = this.el.clientWidth / 2, cy = this.el.clientHeight * .35) {
    z = clamp(z, .5, 4); if (!this.slots || Math.abs(z - this.zoom) < .005) return;
    const sl = this.el.scrollLeft, st = this.el.scrollTop, k = z / this.zoom;
    this.zoom = z;
    const w = this.layout(); this.pw = w;
    for (const s of this.slots) { s.style.width = w + 'px'; s.style.height = Math.round(w / this.doc.aspectOf(+s.dataset.page)) + 'px'; }
    this.inner.style.width = Math.max(w, this.el.clientWidth) + 'px';
    this.el.scrollLeft = (sl + cx) * k - cx; this.el.scrollTop = (st + cy) * k - cy;
    this.cb.onZoom?.(z);
    clearTimeout(this.zt); this.zt = setTimeout(() => this.#rerender(), 180);
  }
  #rerender() {
    const r = this.el.getBoundingClientRect(), pad = r.height * 1.2;
    for (const s of this.slots) {
      const b = s.getBoundingClientRect(), near = b.bottom > r.top - pad && b.top < r.bottom + pad;
      if (near) { delete s.dataset.shown; this.#show(s); } else this.#hide(s);
    }
  }
  fitWidth() { this.setZoom(1); }
  turn(dir) { this.el.scrollBy({ top: dir * (this.el.clientHeight - 64), behavior: 'smooth' }); return Promise.resolve(true); }
  relayout() { const { page, frac } = this.position(); return this.open(page, frac); }
  destroy() { this.io.disconnect(); this.el.remove(); }
}
