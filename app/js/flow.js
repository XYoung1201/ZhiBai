// 流式排版：章节模板 + CSS 多栏分页；同时提供滚动阅读视图
import { h, clamp, esc } from './util.js';

const MAX_TPL = 5;

export class FlowDoc {
  kind = 'flow';
  constructor(book, host) {
    this.book = book;
    this.n = book.sections.length;
    this.host = h('div', { class: 'flow-measure', 'aria-hidden': 'true' });
    host.append(this.host);
    this.html = new Map();
    this.tpls = new Map();
    this.sizes = book.sections.map(s => s.size || 0);
    this.notes = [];
    this.hits = null;
    this.lang = book.lang || '';
  }

  // ---------- 版式 ----------
  setLayout(stageW, stageH, s, insets = { top: 0, bottom: 0 }) {
    const spread = s.spread === 'double' ? stageW >= 600 : s.spread === 'auto' && stageW >= 880 && stageW > stageH * 1.12;
    const fs = s.fontSize;
    const padX = Math.round((spread ? [28, 40, 56] : stageW < 600 ? [18, 26, 36] : [36, 56, 80])[s.margin ?? 1]);
    const head = Math.round(Math.max(34, fs * 2) + insets.top), foot = Math.round(Math.max(30, fs * 1.8) + insets.bottom);
    let rects;
    if (spread) {
      const outerX = Math.round(clamp(stageW * .035, 16, 56)), outerY = Math.round(clamp(stageH * .04, 12, 40));
      const bw = Math.min(stageW - outerX * 2, Math.round(fs * 84)), bh = stageH - outerY * 2;
      const pw = Math.floor(bw / 2), x0 = Math.round((stageW - pw * 2) / 2);
      rects = [{ x: x0, y: outerY, w: pw, h: bh }, { x: x0 + pw, y: outerY, w: pw, h: bh }];
    } else {
      const maxW = Math.round(fs * 36 + padX * 2);
      const w = Math.min(stageW, maxW), x = Math.round((stageW - w) / 2);
      rects = [{ x, y: 0, w, h: stageH }];
    }
    const r = rects[0];
    const L = {
      spread, rects, padX, head, foot,
      pageW: Math.max(120, r.w - padX * 2),
      pageH: Math.max(120, r.h - head - foot - (spread ? 0 : 0)),
      gap: 48,
    };
    const key = JSON.stringify([L.pageW, L.pageH, spread, s.font, fs, s.lineHeight, s.paraSpace, s.indent, s.justify]);
    if (key !== this.layoutKey) { this.layoutKey = key; this.clearTemplates(); }
    this.L = L;
    return L;
  }
  get spread() { return this.L.spread; }
  rects() { return this.L.rects; }
  clearTemplates() { for (const t of this.tpls.values()) t.el.remove(); this.tpls.clear(); }

  // ---------- 章节 ----------
  async load(s) {
    if (!this.html.has(s)) this.html.set(s, Promise.resolve(this.book.sections[s].load()).then(html => {
      if (!this.sizes[s]) this.sizes[s] = html.length;
      return html || '';
    }).catch(e => { console.warn(e); return `<p class="load-error">这一章没能读出来。</p>`; }));
    return this.html.get(s);
  }

  async tpl(s) {
    let t = this.tpls.get(s);
    if (t) { this.tpls.delete(s); this.tpls.set(s, t); return t.ready; }
    t = { s };
    this.tpls.set(s, t);
    t.ready = (async () => {
      const html = await this.load(s);
      const { pageW, pageH, gap } = this.L;
      const el = h('div', { class: 'flow-content', lang: this.lang || null });
      el.style.cssText = `width:${pageW}px;height:${pageH}px;column-width:${pageW}px;column-gap:${gap}px;`;
      el.innerHTML = html;
      el.dataset.s = s;
      for (const img of el.querySelectorAll('img')) { img.loading = 'eager'; img.decoding = 'sync'; img.draggable = false; }
      this.host.append(el);
      t.el = el;
      await Promise.race([Promise.all([...el.querySelectorAll('img')].map(i => i.decode?.().catch(() => {}))), new Promise(r => setTimeout(r, 1500))]);
      this.#decorate(t);
      this.#measure(t);
      while (this.tpls.size > MAX_TPL) { const [k, old] = this.tpls.entries().next().value; if (old.el) old.el.remove(); this.tpls.delete(k); }
      return t;
    })();
    return t.ready;
  }

  #decorate(t) {
    const el = t.el;
    el.querySelectorAll('mark.hl, mark.hit').forEach(m => m.replaceWith(...m.childNodes));
    el.normalize();
    this.#index(t);
    for (const n of this.notes.filter(n => n.s === t.s)) wrap(t, n.a, n.b, 'hl', { 'data-id': n.id, 'data-c': n.color || 'y' });
    if (this.hits?.s === t.s) for (const [a, b] of this.hits.ranges) wrap(t, a, b, 'hit');
    this.#index(t);
    t.anchors = {};
    for (const a of el.querySelectorAll('[data-zb-anchor]')) t.anchors[a.dataset.zbAnchor] = offsetOfNode(t, a);
  }
  #index(t) {
    const w = document.createTreeWalker(t.el, NodeFilter.SHOW_TEXT);
    const nodes = [], starts = []; let off = 0, n;
    while ((n = w.nextNode())) { nodes.push(n); starts.push(off); off += n.data.length; }
    t.nodes = nodes; t.starts = starts; t.len = off;
  }
  #measure(t) {
    const { pageW, gap, spread } = this.L;
    const sw = t.el.scrollWidth;
    t.pages = Math.max(1, Math.round((sw + gap) / (pageW + gap)));
    // 末页若只剩空白（例如尾随的空段落），收掉
    if (t.pages > 1 && t.len) { const lastOff = this.offsetOfPage(t, t.pages - 1); if (lastOff >= t.len) t.pages--; }
    t.empty = !t.len && !t.el.querySelector('img,svg,hr,table');
    t.spreads = spread ? Math.ceil(t.pages / 2) : t.pages;
  }
  async refresh(s) { // 笔记/搜索高亮变化后重绘该章模板
    const t = this.tpls.get(s); if (!t) return;
    await t.ready; this.#decorate(t);
  }

  // ---------- 位置换算 ----------
  #locate(t, off) {
    const { starts, nodes } = t;
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; }
    return { node: nodes[lo], local: off - (starts[lo] || 0), i: lo };
  }
  #rectAt(t, off) {
    if (!t.nodes.length) return null;
    let { i, local } = this.#locate(t, off);
    const r = document.createRange();
    for (let k = 0; k < 40 && i < t.nodes.length; k++, i++, local = 0) {
      const node = t.nodes[i];
      if (!/\S/.test(node.data.slice(local))) continue;
      while (local < node.length && /\s/.test(node.data[local])) local++;
      r.setStart(node, local); r.setEnd(node, Math.min(node.length, local + 1));
      const rc = r.getClientRects()[0];
      if (rc && (rc.width || rc.height)) return rc;
    }
    return null;
  }
  pageOfOffset(t, off) {
    const rc = this.#rectAt(t, clamp(off, 0, Math.max(0, t.len - 1)));
    if (!rc) return off >= t.len ? t.pages - 1 : 0;
    const base = t.el.getBoundingClientRect().left;
    return clamp(Math.floor((rc.left - base + 2) / (this.L.pageW + this.L.gap)), 0, (t.pages || 1) - 1);
  }
  offsetOfPage(t, p) {
    if (p <= 0) return 0;
    let lo = 0, hi = t.len;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.pageOfOffset(t, m) >= p) hi = m; else lo = m + 1; }
    return lo;
  }
  async posOf({ s = 0, o = 0 } = {}) {
    s = clamp(s, 0, this.n - 1);
    const t = await this.tpl(s);
    let p = o > 0 ? this.pageOfOffset(t, o) : 0;
    if (this.L.spread) p -= p % 2;
    return { s, p };
  }
  async anchorOf(pos) { const t = await this.tpl(pos.s); return { s: pos.s, o: this.offsetOfPage(t, pos.p) }; }
  progressOf({ s, o }) {
    const total = this.sizes.reduce((a, b) => a + (b || 1), 0) || 1;
    let before = 0; for (let i = 0; i < s; i++) before += this.sizes[i] || 1;
    const t = this.tpls.get(s);
    const frac = t?.len ? clamp(o / t.len, 0, 1) : 0;
    return clamp((before + frac * (this.sizes[s] || 1)) / total, 0, 1);
  }
  async anchorOfProgress(f) {
    const total = this.sizes.reduce((a, b) => a + (b || 1), 0) || 1;
    let acc = 0, target = f * total;
    for (let s = 0; s < this.n; s++) {
      const sz = this.sizes[s] || 1;
      if (acc + sz >= target || s === this.n - 1) { const t = await this.tpl(s); return { s, o: Math.floor(clamp((target - acc) / sz, 0, 1) * t.len) }; }
      acc += sz;
    }
    return { s: 0, o: 0 };
  }
  async ensureSizes() { // 让进度条更准：后台载入全部章节长度
    for (let s = 0; s < this.n; s++) if (!this.sizes[s]) { await this.load(s); await new Promise(r => setTimeout(r, 0)); }
  }
  async anchorOfToc(e) {
    if (!e.key) return { s: e.s, o: 0 };
    const t = await this.tpl(e.s);
    return { s: e.s, o: t.anchors?.[e.key] ?? 0 };
  }
  tocIndexOf({ s, o }) {
    const toc = this.book.toc; let best = -1;
    const t = this.tpls.get(s);
    for (let i = 0; i < toc.length; i++) {
      const e = toc[i];
      if (e.s < s) best = i;
      else if (e.s === s) { const ao = e.key ? t?.anchors?.[e.key] ?? 0 : 0; if (ao <= o + 1) best = i; }
    }
    return best;
  }
  sectionTitle(s) {
    const toc = this.book.toc; let title = this.book.sections[s]?.title || '';
    if (!title) for (const e of toc) { if (e.s <= s) title = e.label; else break; }
    return title || this.book.title;
  }

  // ---------- 翻页数据源 ----------
  key(pos) { return pos.s + ':' + pos.p; }
  async step(pos, dir) {
    const inc = this.L.spread ? 2 : 1;
    const t = await this.tpl(pos.s);
    if (dir > 0) {
      if (pos.p + inc < t.pages) return { s: pos.s, p: pos.p + inc };
      for (let s = pos.s + 1; s < this.n; s++) { const u = await this.tpl(s); if (!u.empty) return { s, p: 0 }; }
      return null;
    }
    if (pos.p - inc >= 0) return { s: pos.s, p: pos.p - inc };
    for (let s = pos.s - 1; s >= 0; s--) { const u = await this.tpl(s); if (!u.empty) { const last = u.pages - 1; return { s, p: this.L.spread ? last - last % 2 : last }; } }
    return null;
  }
  async fill(faces, pos) {
    const t = await this.tpl(pos.s);
    const { pageW, pageH, gap, padX, head, foot, spread } = this.L;
    const title = this.sectionTitle(pos.s);
    faces.forEach((face, i) => {
      const p = pos.p + i;
      face.replaceChildren();
      face.classList.add('flow-face');
      face.dataset.s = pos.s; face.dataset.p = p;
      face.style.setProperty('--pad-x', padX + 'px');
      const headText = spread ? (i === 0 ? this.book.title : title) : title;
      const fhead = h('div', { class: 'fhead', style: { height: head + 'px' } }, h('span', null, headText));
      const ffoot = h('div', { class: 'ffoot', style: { height: foot + 'px' } });
      const body = h('div', { class: 'fbody', style: { top: head + 'px', left: padX + 'px', width: pageW + 'px', height: pageH + 'px' } });
      if (p < t.pages) {
        const c = t.el.cloneNode(true);
        c.style.transform = `translate3d(${-p * (pageW + gap)}px,0,0)`;
        body.append(c);
        ffoot.append(h('span', null, `${p + 1}`), h('span', { class: 'of' }, ` / ${t.pages}`));
        if (p === 0) fhead.classList.add('chapter-start');
      } else face.classList.add('blank');
      face.append(fhead, body, ffoot);
    });
  }

  // ---------- 笔记 / 搜索 ----------
  setNotes(notes) { this.notes = notes || []; for (const t of this.tpls.values()) if (t.el) this.#decorate(t); }
  setHits(hits) { const old = this.hits?.s; this.hits = hits; for (const s of new Set([old, hits?.s])) if (s != null) this.refresh(s); }
  offsetIn(root, node, local) { // 选区端点 → 章内偏移（root 为某个克隆）
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let off = 0, n;
    if (node.nodeType !== 3) { const kid = node.childNodes[local]; if (kid) { node = kid; local = 0; const f = firstText(kid); if (f) { node = f; } else { return offsetOfNodeIn(root, kid); } } }
    while ((n = w.nextNode())) { if (n === node) return off + local; off += n.data.length; }
    return off;
  }
  async textOf(s) { const t = await this.tpl(s); return t.el.textContent; }
  async search(q, onResult, signal) {
    const ql = q.toLowerCase(); let count = 0;
    const div = document.createElement('div');
    for (let s = 0; s < this.n; s++) {
      if (signal?.aborted) return;
      div.innerHTML = await this.load(s);
      const text = div.textContent, tl = text.toLowerCase();
      let i = tl.indexOf(ql);
      while (i >= 0 && count < 500) {
        onResult({ s, o: i, len: q.length, title: this.sectionTitle(s), before: text.slice(Math.max(0, i - 24), i), match: text.slice(i, i + q.length), after: text.slice(i + q.length, i + q.length + 40) });
        count++; i = tl.indexOf(ql, i + ql.length);
      }
      if (s % 8 === 7) await new Promise(r => setTimeout(r, 0));
    }
  }
  destroy() { this.host.remove(); this.book.destroy?.(); }
}

function firstText(n) { const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); return w.nextNode(); }
function offsetOfNodeIn(root, el) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let off = 0, n;
  while ((n = w.nextNode())) { if (el.contains(n) || (el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) return off; off += n.data.length; }
  return off;
}
function offsetOfNode(t, el) { return offsetOfNodeIn(t.el, el); }

function wrap(t, a, b, cls, attrs = {}) {
  if (b <= a) return;
  const segs = [];
  for (let i = 0; i < t.nodes.length; i++) {
    const s0 = t.starts[i], n = t.nodes[i], s1 = s0 + n.data.length;
    if (s1 <= a) continue; if (s0 >= b) break;
    segs.push([n, Math.max(0, a - s0), Math.min(n.data.length, b - s0)]);
  }
  for (const [n, x, y] of segs) {
    if (!n.parentNode || !n.data.slice(x, y).trim() && y - x < 2) continue;
    const r = document.createRange(); r.setStart(n, x); r.setEnd(n, y);
    const m = document.createElement('mark'); m.className = cls;
    for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
    try { r.surroundContents(m); } catch {}
  }
}

// ---------- 滚动视图（上下滑动阅读） ----------
export class FlowScroll {
  constructor(doc, stage, { onChange, onTap, onLink } = {}) {
    this.doc = doc; this.cb = { onChange, onTap, onLink };
    this.el = h('div', { class: 'scroller flow-scroller' });
    this.inner = h('div', { class: 'scroll-inner' });
    this.el.append(this.inner);
    stage.append(this.el);
    this.loaded = new Map();
    this.io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && this.#extend(+e.target.dataset.dir)), { root: this.el, rootMargin: '800px 0px' });
    this.topSentinel = h('div', { class: 'sentinel', dataset: { dir: -1 } });
    this.botSentinel = h('div', { class: 'sentinel', dataset: { dir: 1 } });
    this.el.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    let down;
    this.el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now(), target: e.target }; });
    this.el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 600) return;
      const sel = getSelection(); if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const a = down.target.closest?.('a[href]'); if (a) { this.cb.onLink?.(a, e); return; }
      const r = this.el.getBoundingClientRect(), fy = (e.clientY - r.top) / r.height;
      this.cb.onTap?.(fy < .25 ? -1 : fy > .75 ? 1 : 0, e);
    });
    this.el.addEventListener('click', e => { if (e.target.closest('a[href]')) e.preventDefault(); });
  }
  get spread() { return false; }
  async #section(s) {
    if (this.loaded.has(s)) return this.loaded.get(s);
    const html = await this.doc.load(s);
    const el = h('section', { class: 'flow-content scroll-section', lang: this.doc.lang || null, dataset: { s } });
    el.innerHTML = html;
    for (const n of this.doc.notes.filter(n => n.s === s)) { const t = { el }; idx(t); wrap(t, n.a, n.b, 'hl', { 'data-id': n.id, 'data-c': n.color || 'y' }); }
    this.loaded.set(s, el);
    return el;
  }
  async open({ s, o }) {
    this.busy = true;
    this.inner.replaceChildren();
    this.loaded.clear();
    this.first = this.last = s;
    const el = await this.#section(s);
    this.inner.append(this.topSentinel, el, this.botSentinel);
    this.io.observe(this.topSentinel); this.io.observe(this.botSentinel);
    await new Promise(r => requestAnimationFrame(r));
    this.#scrollToOffset(el, o);
    this.busy = false;
    this.#onScroll();
  }
  go(a) { return this.open(a); }
  #scrollToOffset(el, o) {
    if (!o) { this.el.scrollTop = el.offsetTop - 24; return; }
    const t = { el }; idx(t);
    let i = 0; while (i + 1 < t.nodes.length && t.starts[i + 1] <= o) i++;
    const n = t.nodes[i]; if (!n) return;
    const r = document.createRange(); r.setStart(n, clamp(o - t.starts[i], 0, n.length)); r.setEnd(n, clamp(o - t.starts[i] + 1, 0, n.length));
    const rc = r.getBoundingClientRect(), base = this.el.getBoundingClientRect();
    this.el.scrollTop += rc.top - base.top - 64;
  }
  async #extend(dir) {
    if (this.busy || this.extending) return;
    const s = dir > 0 ? this.last + 1 : this.first - 1;
    if (s < 0 || s >= this.doc.n) return;
    this.extending = true;
    const el = await this.#section(s);
    if (dir > 0) { this.botSentinel.before(el); this.last = s; }
    else {
      const before = this.el.scrollHeight;
      this.topSentinel.after(el); this.first = s;
      this.el.scrollTop += this.el.scrollHeight - before;
    }
    // 只保留附近几章，控制 DOM 规模
    const keep = 4;
    while (this.last - this.first >= keep) {
      const cur = this.anchor()?.s ?? s;
      if (cur - this.first > this.last - cur) { const old = this.loaded.get(this.first); const hgt = old.offsetHeight; old.remove(); this.loaded.delete(this.first++); this.el.scrollTop -= hgt; }
      else { this.loaded.get(this.last).remove(); this.loaded.delete(this.last--); }
    }
    this.extending = false;
  }
  anchor() {
    const r = this.el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + 56;
    let node, off;
    if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, y); node = c?.offsetNode; off = c?.offset; }
    else if (document.caretRangeFromPoint) { const c = document.caretRangeFromPoint(x, y); node = c?.startContainer; off = c?.startOffset; }
    const sec = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('.scroll-section');
    if (!sec) { const any = [...this.inner.querySelectorAll('.scroll-section')].find(e => e.getBoundingClientRect().bottom > r.top + 56); return any ? { s: +any.dataset.s, o: 0 } : null; }
    return { s: +sec.dataset.s, o: this.doc.offsetIn(sec, node, off || 0) };
  }
  #onScroll() {
    if (this.busy) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => { const a = this.anchor(); if (a) this.cb.onChange?.(a); });
  }
  turn(dir) { this.el.scrollBy({ top: dir * (this.el.clientHeight - 72), behavior: 'smooth' }); return Promise.resolve(true); }
  relayout() { const a = this.anchor(); return a ? this.open(a) : null; }
  refreshNotes() { const a = this.anchor(); if (a) this.open(a); }
  destroy() { this.io.disconnect(); this.el.remove(); }
}
function idx(t) {
  const w = document.createTreeWalker(t.el, NodeFilter.SHOW_TEXT);
  const nodes = [], starts = []; let off = 0, n;
  while ((n = w.nextNode())) { nodes.push(n); starts.push(off); off += n.data.length; }
  t.nodes = nodes; t.starts = starts; t.len = off;
}
export { esc };
