// 翻页引擎：仿真（卷页）、覆盖、平移、淡入、无；跟手拖拽、点按分区、滚轮、双指缩放（定版书）
// 数据源接口 src：
//   spread: boolean            是否双页
//   rects(): [rect] | [rectL, rectR]   各页在舞台中的位置
//   fill(faces, pos): Promise  把 pos 对应的页面画进 faces
//   step(pos, dir): Promise<pos|null>
//   key(pos): string
//   zoomable?: boolean, refine?(faces, scale)
import { clamp, lerp, ease, tween, reducedMotion, h } from './util.js';

const TAP_MOVE = 10;

export class Pager {
  constructor(stage, src, { effect = 'curl', onChange, onTap, onEdge, onLink, onDoubleTap } = {}) {
    this.stage = stage; this.src = src; this.effectName = effect;
    this.cb = { onChange, onTap, onEdge, onLink, onDoubleTap };
    this.root = h('div', { class: 'pager' });
    this.spine = h('div', { class: 'spine' });
    stage.append(this.root);
    this.cur = null; this.next = null; this.prev = null;
    this.zoom = { s: 1, x: 0, y: 0 };
    this.#bind();
  }

  get effect() { return reducedMotion() ? EFFECTS.fade : EFFECTS[this.effectName] || EFFECTS.slide; }
  setEffect(name) { this.effectName = name; }

  #layer() {
    const rects = this.src.rects();
    const el = h('div', { class: 'layer' });
    const sides = rects.length === 2 ? ['left', 'right'] : ['single'];
    const faces = rects.map((r, i) => {
      const f = h('div', { class: 'face ' + sides[i], dataset: { side: sides[i] } });
      placeFace(f, r);
      el.append(f);
      return f;
    });
    el.classList.add('hidden');
    this.root.append(el);
    return { el, faces, pos: null };
  }
  #drop(L) { if (L && L !== this.cur) { L.el.remove(); } }

  async open(pos) {
    this.#reset();
    const rects = this.src.rects();
    this.root.classList.toggle('spread', rects.length === 2);
    if (rects.length === 2) { const L = rects[0], R = rects[1]; Object.assign(this.spine.style, { left: L.x + 'px', top: L.y + 'px', width: (R.x + R.w - L.x) + 'px', height: L.h + 'px' }); this.root.append(this.spine); } else this.spine.remove();
    const L = this.#layer();
    L.pos = pos;
    await this.src.fill(L.faces, pos);
    if (this.cur && this.cur !== L) this.cur.el.remove();
    this.cur = L; L.el.classList.remove('hidden'); L.el.classList.add('current');
    this.pos = pos;
    this.cb.onChange?.(pos, L.faces);
    this.#prepareNeighbors();
  }
  go(pos) { return this.open(pos); }
  relayout() { if (this.pos != null) return this.open(this.pos); }

  #reset() {
    this.anim?.finish?.();
    this.t && this.#cleanupTransition(this.t);
    this.t = null;
    this.gen = (this.gen || 0) + 1;
    for (const el of [...this.root.children]) if (el !== this.cur?.el && el !== this.spine) el.remove();
    for (const s of ['prev', 'next']) { this[s]?.layer && this.#drop(this[s].layer); this[s] = null; }
    this.#resetZoom(false);
  }

  #prepareNeighbors() {
    const gen = this.gen = (this.gen || 0) + 1;
    for (const dir of [1, -1]) {
      const slot = dir > 0 ? 'next' : 'prev';
      if (this[slot]?.layer) this.#drop(this[slot].layer);
      const entry = { layer: null, none: false };
      this[slot] = entry;
      entry.ready = (async () => {
        await new Promise(r => setTimeout(r, dir > 0 ? 30 : 140));
        if (gen !== this.gen) return null;
        const np = await this.src.step(this.pos, dir);
        if (gen !== this.gen) return null;
        if (np == null) { entry.none = true; return null; }
        const L = this.#layer(); L.pos = np;
        await this.src.fill(L.faces, np);
        if (gen !== this.gen) { L.el.remove(); return null; }
        entry.layer = L;
        return L;
      })().catch(e => { console.warn(e); return null; });
    }
  }

  // ---------- 翻页 ----------
  turn(dir) {
    if ((this.pending || 0) >= 2) return Promise.resolve(false);
    this.pending = (this.pending || 0) + 1;
    const run = (this.queue || Promise.resolve()).then(() => this.#turn(dir)).finally(() => { this.pending--; });
    this.queue = run.catch(() => {});
    return run;
  }
  async #turn(dir) {
    if (this.zoom.s > 1.01) this.#resetZoom(true);
    if (this.t) { this.anim?.finish(); await this.settling; }
    const slot = this[dir > 0 ? 'next' : 'prev'];
    const nb = slot?.layer || await slot?.ready;
    if (!nb) { this.cb.onEdge?.(dir); this.#nudge(dir); return false; }
    if (this.t) return false;
    const t = this.#begin(dir, nb, null);
    const target = dir > 0 ? 1 : 0;
    await this.#animate(t, target, true);
    return true;
  }

  #begin(dir, nb, grab) {
    const top = dir > 0 ? this.cur : nb, bottom = dir > 0 ? nb : this.cur;
    const rects = this.src.rects();
    const t = { dir, nb, top, bottom, spread: rects.length === 2, rects, SW: this.stage.clientWidth, SH: this.stage.clientHeight, grab, p: dir > 0 ? 0 : 1 };
    bottom.el.classList.remove('hidden'); top.el.classList.remove('hidden');
    bottom.el.style.zIndex = 1; top.el.style.zIndex = 2;
    this.root.classList.add('turning');
    this.t = t;
    this.effect.begin(t, this);
    this.effect.set(t, t.p);
    return t;
  }

  #animate(t, target, auto) {
    const eff = this.effect;
    const dist = Math.abs(target - t.p);
    const base = eff.duration || 420;
    const duration = auto ? base : clamp(base * (0.35 + dist * 0.75), 140, base);
    this.settling = new Promise(resolve => {
      const done = () => { this.#finish(t, target); resolve(); };
      if (eff.animate) this.anim = eff.animate(t, target, duration, auto, done);
      else {
        const from = t.p;
        this.anim = tween({ from, to: target, duration, easing: auto ? ease.inOutCubic : ease.outCubic, onUpdate: p => { t.p = p; eff.set(t, p); }, onDone: done });
      }
    });
    return this.settling;
  }

  #finish(t, target) {
    const completed = t.dir > 0 ? target >= 1 : target <= 0;
    this.#cleanupTransition(t);
    this.t = null; this.anim = null;
    this.root.classList.remove('turning');
    if (!completed) { t.nb.el.classList.add('hidden'); return; }
    const old = this.cur;
    this.cur = t.nb; this.pos = t.nb.pos;
    old.el.classList.remove('current'); t.nb.el.classList.add('current');
    // 旧页变成反方向的预备页，免去重绘
    const keep = t.dir > 0 ? 'prev' : 'next', other = t.dir > 0 ? 'next' : 'prev';
    const gen = this.gen = (this.gen || 0) + 1;
    if (this[keep]?.layer && this[keep].layer !== old) this.#drop(this[keep].layer);
    old.el.classList.add('hidden');
    this[keep] = { layer: old, ready: Promise.resolve(old) };
    this[other] = null;
    this.cb.onChange?.(this.pos, this.cur.faces);
    const entry = { layer: null };
    this[other] = entry;
    entry.ready = (async () => {
      const np = await this.src.step(this.pos, t.dir);
      if (gen !== this.gen || np == null) return null;
      const L = this.#layer(); L.pos = np;
      await this.src.fill(L.faces, np);
      if (gen !== this.gen) { L.el.remove(); return null; }
      entry.layer = L; return L;
    })().catch(() => null);
  }

  #cleanupTransition(t) {
    this.effect.end?.(t, this);
    for (const L of [t.top, t.bottom]) { L.el.style.zIndex = ''; L.el.style.transform = ''; L.el.style.opacity = ''; }
  }

  #nudge(dir) {
    if (reducedMotion() || !this.cur) return;
    this.cur.el.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-dir * 14}px)` }, { transform: 'translateX(0)' }], { duration: 320, easing: 'cubic-bezier(.3,.7,.4,1)' });
  }

  // ---------- 手势 ----------
  #bind() {
    const st = this.stage;
    this.ac = new AbortController();
    const sig = { signal: this.ac.signal };
    let g = null; const pts = new Map();
    let lastTap = 0, tapTimer = 0;
    st.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const formula = e.target.closest?.('.math-block');
      if (formula && formula.scrollWidth > formula.clientWidth) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && this.src.zoomable) { g = { pinch: true, ...this.#pinchStart(pts) }; return; }
      if (pts.size > 1) return;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), type: e.pointerType, moved: false, hist: [[performance.now(), e.clientX]], target: e.target };
    }, sig);
    st.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!g) return;
      if (g.pinch) { this.#pinchMove(g, pts); return; }
      if (e.pointerId !== g.id) return;
      g.x = e.clientX; g.y = e.clientY;
      g.hist.push([performance.now(), e.clientX]); if (g.hist.length > 6) g.hist.shift();
      const dx = g.x - g.x0, dy = g.y - g.y0;
      if (!g.moved && Math.hypot(dx, dy) > TAP_MOVE) g.moved = true;
      if (this.zoom.s > 1.01) { this.#panBy(e.movementX || 0, e.movementY || 0, g); return; }
      if (g.type === 'mouse' || g.dragging === false) return;
      // 手指比鼠标抖：触屏要走得更远、更「横」才算翻页，免得轻触时书页微微晃动
      const touch = g.type !== 'pen' && g.type !== 'mouse';
      if (!g.dragging && g.moved && (!touch || Math.abs(dx) > 16)) {
        const sel = getSelection();
        if (Math.abs(dx) < Math.abs(dy) * (touch ? 1.5 : 1.15) || (sel && !sel.isCollapsed)) { g.dragging = false; return; }
        if (this.t) { g.dragging = false; return; }
        const dir = dx < 0 ? 1 : -1;
        const slot = this[dir > 0 ? 'next' : 'prev'];
        if (!slot?.layer) { if (slot?.none || !slot) { g.edge = dir; } return; }
        g.dragging = true; g.dir = dir;
        try { st.setPointerCapture?.(e.pointerId); } catch {}
        const r = this.stage.getBoundingClientRect();
        this.#begin(dir, slot.layer, { x0: g.x0 - r.left, y0: g.y0 - r.top, touch });
      }
      if (g.dragging && this.t) {
        const r = this.stage.getBoundingClientRect();
        const p = this.effect.drag(this.t, g.x - g.x0, g.y - g.y0, g.x - r.left, g.y - r.top);
        this.t.p = clamp(p, 0, 1);
      } else if (g.edge && Math.abs(dx) > 30 && !g.edgeShown) { g.edgeShown = true; this.cb.onEdge?.(g.edge); }
    }, sig);
    const up = e => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.pinch) { if (pts.size === 0) { this.#pinchEnd(g); g = null; } return; }
      if (e.pointerId !== g.id) return;
      const cur = g; g = null;
      if (cur.dragging && this.t) {
        const [t1, x1] = cur.hist[0], [t2, x2] = cur.hist[cur.hist.length - 1];
        const v = (x2 - x1) / Math.max(1, t2 - t1); // px/ms
        const t = this.t;
        let complete;
        if (Math.abs(v) > .35) complete = t.dir > 0 ? v < 0 : v > 0;
        else complete = t.dir > 0 ? t.p > .22 : t.p < .78;
        if (e.type === 'pointercancel') complete = false;
        this.#animate(t, complete ? (t.dir > 0 ? 1 : 0) : (t.dir > 0 ? 0 : 1), false);
        return;
      }
      if (e.type === 'pointercancel' || cur.moved || performance.now() - cur.t0 > 600) return;
      const sel = getSelection(); if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const link = cur.target.closest?.('a[href]');
      if (link && this.cb.onLink) { this.cb.onLink(link, e); return; }
      const r = this.stage.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const zone = fx < .3 ? -1 : fx > .7 ? 1 : 0;
      if (zone && this.zoom.s <= 1.01) { this.cb.onTap?.(zone, e); return; }
      const now = performance.now();
      if (this.src.zoomable && now - lastTap < 300) { clearTimeout(tapTimer); lastTap = 0; this.#doubleTap(e.clientX - r.left, e.clientY - r.top); return; }
      lastTap = now;
      if (this.src.zoomable) tapTimer = setTimeout(() => this.cb.onTap?.(zone, e), 260);
      else this.cb.onTap?.(zone, e);
    };
    st.addEventListener('pointerup', up, sig);
    st.addEventListener('pointercancel', up, sig);
    st.addEventListener('click', e => { if (e.target.closest('a[href]')) e.preventDefault(); }, sig);

    // 滚轮：一次手势只翻一页
    let wheelLock = 0, acc = 0, lastWheel = 0;
    st.addEventListener('wheel', e => {
      if (e.ctrlKey && this.src.zoomable) { e.preventDefault(); const r = st.getBoundingClientRect(); this.#zoomAt(this.zoom.s * Math.exp(-e.deltaY * .01), e.clientX - r.left, e.clientY - r.top); this.#refineSoon(); return; }
      if (this.zoom.s > 1.01) { e.preventDefault(); this.#panBy(-e.deltaX, -e.deltaY); return; }
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheel > 220) { acc = 0; wheelLock = 0; }
      lastWheel = now;
      if (wheelLock) return;
      acc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(acc) > 42) { wheelLock = 1; this.turn(acc > 0 ? 1 : -1); acc = 0; }
    }, { passive: false, signal: this.ac.signal });
  }

  // ---------- 缩放（定版书） ----------
  #pinchStart(pts) {
    const [a, b] = [...pts.values()];
    const r = this.stage.getBoundingClientRect();
    return { d0: Math.hypot(a.x - b.x, a.y - b.y), s0: this.zoom.s, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, x0: this.zoom.x, y0: this.zoom.y };
  }
  #pinchMove(g, pts) {
    if (pts.size < 2) return;
    const [a, b] = [...pts.values()];
    const r = this.stage.getBoundingClientRect();
    const s = clamp(g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, .8, 6);
    const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    // 以起始中点为锚：内容点 (g.cx - x0)/s0 跟随手指中点
    this.zoom.s = s;
    this.zoom.x = cx - (g.cx - g.x0) * s / g.s0;
    this.zoom.y = cy - (g.cy - g.y0) * s / g.s0;
    this.#applyZoom(false);
  }
  #pinchEnd() { if (this.zoom.s < 1.05) this.#resetZoom(true); else { this.#clampPan(); this.#applyZoom(true); this.#refineSoon(); } }
  #doubleTap(x, y) {
    if (this.zoom.s > 1.01) { this.#resetZoom(true); return; }
    this.#zoomAt(2.2, x, y, true);
    this.#refineSoon();
  }
  #zoomAt(s, x, y, animated) {
    s = clamp(s, 1, 6);
    const k = s / this.zoom.s;
    this.zoom.x = x - (x - this.zoom.x) * k; this.zoom.y = y - (y - this.zoom.y) * k; this.zoom.s = s;
    if (s <= 1.01) return this.#resetZoom(animated);
    this.#clampPan(); this.#applyZoom(animated);
  }
  #panBy(dx, dy) { this.zoom.x += dx; this.zoom.y += dy; this.#clampPan(); this.#applyZoom(false); }
  #clampPan() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight, s = this.zoom.s;
    this.zoom.x = clamp(this.zoom.x, W - W * s, 0); this.zoom.y = clamp(this.zoom.y, H - H * s, 0);
  }
  #applyZoom(animated) {
    const el = this.cur?.el; if (!el) return;
    el.style.transition = animated ? 'transform .32s cubic-bezier(.2,.8,.2,1)' : 'none';
    el.style.transformOrigin = '0 0';
    const tf = this.zoom.s === 1 ? '' : `translate(${this.zoom.x}px, ${this.zoom.y}px) scale(${this.zoom.s})`;
    el.style.transform = tf;
    // 中缝随书页一起缩放平移，而不是钉在屏幕正中
    Object.assign(this.spine.style, { transition: el.style.transition, transformOrigin: `${-parseFloat(this.spine.style.left || 0)}px ${-parseFloat(this.spine.style.top || 0)}px`, transform: tf });
    this.root.classList.toggle('zoomed', this.zoom.s > 1.01);
  }
  #resetZoom(animated) {
    const was = this.zoom.s;
    this.zoom = { s: 1, x: 0, y: 0 };
    this.#applyZoom(animated);
    if (was > 1.01) this.#refineSoon();
  }
  #refineSoon() {
    clearTimeout(this.refineT);
    this.refineT = setTimeout(() => this.cur && this.src.refine?.(this.cur.faces, this.zoom.s), 280);
  }
  get zoomed() { return this.zoom.s > 1.01; }

  destroy() { this.#reset(); this.ac.abort(); this.root.remove(); }
}

function placeFace(f, r) { Object.assign(f.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); }

// ---------- 效果 ----------
const shadowFace = t => (t.spread ? t.top.faces[1] : t.top.faces[0]);
const EFFECTS = {
  none: {
    duration: 1,
    begin() {}, set(t, p) { t.top.el.style.opacity = p > .5 ? 0 : 1; }, drag(t, dx) { return t.dir > 0 ? (dx < -40 ? 1 : 0) : (dx > 40 ? 0 : 1); },
  },
  fade: {
    duration: 260,
    begin() {}, set(t, p) { t.top.el.style.opacity = 1 - p; },
    drag(t, dx) { return t.dir > 0 ? -dx / t.SW * 1.6 : 1 - dx / t.SW * 1.6; },
  },
  slide: {
    duration: 380,
    begin() {},
    set(t, p) { t.top.el.style.transform = `translate3d(${-p * t.SW}px,0,0)`; t.bottom.el.style.transform = `translate3d(${(1 - p) * t.SW}px,0,0)`; },
    drag(t, dx) { return t.dir > 0 ? -dx / t.SW : 1 - dx / t.SW; },
  },
  cover: {
    duration: 400,
    begin(t) { t.top.el.classList.add('covering'); },
    set(t, p) { t.top.el.style.transform = `translate3d(${-p * t.SW}px,0,0)`; t.top.el.style.setProperty('--cover-shadow', (1 - Math.abs(p - .5) * 2) * .9 + .1); },
    drag(t, dx) { return t.dir > 0 ? -dx / t.SW : 1 - dx / t.SW; },
    end(t) { t.top.el.classList.remove('covering'); t.top.el.style.removeProperty('--cover-shadow'); },
  },
  curl: {
    duration: 560,
    begin(t, pager) {
      const leaf = t.spread ? t.top.faces[1] : t.top.faces[0];
      const r = t.spread ? t.rects[1] : t.rects[0];
      const W = r.w, H = r.h;
      const corner = t.grab ? (t.grab.y0 - r.y < H * .3 ? 0 : t.grab.y0 - r.y > H * .62 ? H : null) : H;
      Object.assign(t, { leaf, r, W, H, cy: corner ?? H, cornerGrab: corner != null });
      // 背面：双页取下一跨页的左页；单页用当前页的镜像透影
      let back;
      if (t.spread) { back = t.bottom.faces[0]; t.backHome = { parent: back.parentNode, style: back.getAttribute('style') }; }
      else {
        back = cloneFace(leaf);
        back.classList.add('ghost-back');
      }
      t.back = back;
      t.flap = h('div', { class: 'curl-flap' });
      Object.assign(t.flap.style, { left: r.x + 'px', top: r.y + 'px', width: W + 'px', height: H + 'px' });
      Object.assign(back.style, { left: '0px', top: '0px', width: W + 'px', height: H + 'px', transformOrigin: '0 0' });
      t.shade = h('div', { class: 'curl-shade' });
      back.append(t.shade);
      t.flap.append(back);
      t.under = h('div', { class: 'curl-under' });
      Object.assign(t.under.style, { left: r.x + 'px', top: r.y + 'px', width: W + 'px', height: H + 'px' });
      pager.root.append(t.under, t.flap);
      t.P = t.dir > 0 ? [W, t.cy] : [-W, t.cy];
    },
    set(t, p) {
      const { W, H, cy } = t;
      const th = Math.PI * p;
      const lift = Math.min(W * .22, H * .1) * (cy === 0 ? -1 : 1);
      t.P = [W * Math.cos(th), cy - lift * Math.sin(th)];
      curlRender(t);
    },
    drag(t, dx, dy) {
      const { W, cy } = t;
      const ky = t.grab?.touch ? (t.cornerGrab ? .4 : .08) : (t.cornerGrab ? 1 : .18);
      let P = t.dir > 0 ? [W + dx, cy + dy * ky] : [-W + dx * 2, cy + dy * ky];
      if (cy === t.H) P[1] = Math.min(P[1], t.H); else P[1] = Math.max(P[1], 0);
      t.P = P; curlRender(t);
      return (W - t.P[0]) / (2 * W);
    },
    animate(t, target, duration, auto, done) {
      if (auto) {
        return tween({ from: t.p, to: target, duration, easing: ease.inOutSine, onUpdate: p => { t.p = p; EFFECTS.curl.set(t, p); }, onDone: done });
      }
      const P0 = t.P.slice(), T = target >= 1 ? [-t.W, t.cy] : [t.W, t.cy];
      const lift = Math.min(t.W * .12, t.H * .05) * (t.cy === 0 ? -1 : 1);
      return tween({
        from: 0, to: 1, duration, easing: ease.outCubic,
        onUpdate: k => { t.P = [lerp(P0[0], T[0], k), lerp(P0[1], T[1], k) - lift * Math.sin(Math.PI * k)]; t.p = (t.W - t.P[0]) / (2 * t.W); curlRender(t); },
        onDone: done,
      });
    },
    end(t) {
      t.leaf.style.clipPath = ''; t.leaf.style.webkitClipPath = '';
      t.shade?.remove(); t.under?.remove();
      if (t.spread && t.backHome) {
        t.back.style.cssText = t.backHome.style || ''; t.back.style.clipPath = ''; t.back.style.transform = '';
        t.backHome.parent.prepend(t.back);
      }
      t.flap?.remove();
    },
  },
};

function cloneFace(face) {
  const c = face.cloneNode(true);
  const src = face.querySelectorAll('canvas'), dst = c.querySelectorAll('canvas');
  src.forEach((s, i) => { try { dst[i].getContext('2d').drawImage(s, 0, 0); } catch {} });
  c.classList.remove('left', 'right');
  return c;
}

// 卷页几何：折线为角点 C 与当前角点 P 的中垂线；折起部分沿折线镜像为翻起的纸背
function clampP(P, W, H, cy) {
  let [x, y] = P;
  const s1 = [0, cy], s2 = [0, H - cy], D = Math.hypot(W, H);
  let d = Math.hypot(x - s1[0], y - s1[1]);
  if (d > W) { x = s1[0] + (x - s1[0]) * W / d; y = s1[1] + (y - s1[1]) * W / d; }
  d = Math.hypot(x - s2[0], y - s2[1]);
  if (d > D) { x = s2[0] + (x - s2[0]) * D / d; y = s2[1] + (y - s2[1]) * D / d; }
  return [x, y];
}
function clipHalf(poly, M, n, sign) {
  const out = [], f = q => ((q[0] - M[0]) * n[0] + (q[1] - M[1]) * n[1]) * sign;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const k = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]); }
  }
  return out;
}
const polyCSS = pts => pts.length < 3 ? 'polygon(0 0,0 0,0 0)' : `polygon(${pts.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(',')})`;
function gradientAt(W, H, n, M, stops) {
  const ang = Math.atan2(n[0], -n[1]) * 180 / Math.PI;
  const L = Math.abs(W * n[0]) + Math.abs(H * n[1]);
  const s0 = (M[0] - W / 2) * n[0] + (M[1] - H / 2) * n[1] + L / 2;
  return `linear-gradient(${ang.toFixed(2)}deg, ${stops.map(([c, d]) => `${c} ${(s0 + d).toFixed(1)}px`).join(',')})`;
}
function curlRender(t) {
  const { W, H, cy } = t;
  const C = [W, cy];
  const P = t.P = clampP(t.P, W, H, cy);
  const dx = C[0] - P[0], dy = C[1] - P[1], len = Math.hypot(dx, dy);
  const leafStyle = t.leaf.style;
  if (len < .5) {
    leafStyle.clipPath = ''; t.flap.style.visibility = 'hidden'; t.under.style.visibility = 'hidden';
    return;
  }
  t.flap.style.visibility = ''; t.under.style.visibility = '';
  const n = [dx / len, dy / len], M = [(C[0] + P[0]) / 2, (C[1] + P[1]) / 2];
  const rect = [[0, 0], [W, 0], [W, H], [0, H]];
  const front = clipHalf(rect, M, n, -1), fold = clipHalf(rect, M, n, 1);
  leafStyle.clipPath = polyCSS(front);
  // 纸背：Rf·S 变换（两次反射 = 旋转 + 平移，故纸背内容不镜像）
  const a = 2 * n[0] * n[0] - 1, b = 2 * n[0] * n[1], c = -2 * n[0] * n[1], d = 1 - 2 * n[1] * n[1];
  const v = [W - M[0], -M[1]], dot = v[0] * n[0] + v[1] * n[1];
  const e = v[0] - 2 * dot * n[0] + M[0], f = v[1] - 2 * dot * n[1] + M[1];
  t.back.style.transform = `matrix(${a},${b},${c},${d},${e},${f})`;
  t.back.style.clipPath = polyCSS(fold.map(([x, y]) => [W - x, y]));
  // 光影：纸背靠折线处偏暗，下层页面在折线外侧投下阴影
  const depth = Math.min(1, len / (W * .5));
  const band = Math.max(24, len * .5);
  const n2 = [-n[0], n[1]], M2 = [W - M[0], M[1]];
  t.shade.style.background = gradientAt(W, H, n2, M2, [['rgba(0,0,0,.16)', 0], ['rgba(255,255,255,.10)', band * .35], ['rgba(0,0,0,.03)', band], ['rgba(0,0,0,.10)', band * 2.2]]);
  t.under.style.clipPath = polyCSS(fold);
  t.under.style.background = gradientAt(W, H, n, M, [['rgba(0,0,0,0)', -1], [`rgba(0,0,0,${(.32 * depth + .06).toFixed(3)})`, 0], ['rgba(0,0,0,0)', Math.max(18, Math.min(70, len * .18))]]);
}
