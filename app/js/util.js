// 通用小工具：DOM、动画、格式化、拼音首字母、模糊匹配
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const frame = () => new Promise(r => requestAnimationFrame(r));
export const idle = (fn, timeout = 600) => (window.requestIdleCallback || ((f) => setTimeout(f, 80)))(fn, { timeout });
export const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;
export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// 动效由应用内「减弱动效」开关决定（翻页与开书是读者主动选择的体验，不随系统设置一刀切）
export const reducedMotion = () => document.documentElement.classList.contains('calm');
export const ease = {
  outCubic: t => 1 - (1 - t) ** 3,
  inOutCubic: t => (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outQuart: t => 1 - (1 - t) ** 4,
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: t => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
};

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export function debounce(fn, ms) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); }; d.cancel = () => clearTimeout(t);
  return d;
}
export function throttle(fn, ms) {
  let last = 0, t;
  return (...a) => {
    const now = performance.now(), wait = ms - (now - last);
    clearTimeout(t);
    if (wait <= 0) { last = now; fn(...a); } else t = setTimeout(() => { last = performance.now(); fn(...a); }, wait);
  };
}

export class Emitter {
  #m = new Map();
  on(e, f) { (this.#m.get(e) || this.#m.set(e, new Set()).get(e)).add(f); return () => this.off(e, f); }
  off(e, f) { this.#m.get(e)?.delete(f); }
  emit(e, ...a) { for (const f of [...(this.#m.get(e) || [])]) f(...a); }
}

// 以 rAF 驱动的补间；返回可提前结束的句柄
export function tween({ from = 0, to = 1, duration = 300, easing = ease.outCubic, onUpdate, onDone }) {
  let start = 0, id = 0, done = false;
  const finish = (v = to) => { if (done) return; done = true; cancelAnimationFrame(id); onUpdate?.(v); onDone?.(); };
  const step = now => {
    if (!start) start = now;
    const t = duration <= 0 ? 1 : Math.min(1, (now - start) / duration);
    onUpdate?.(lerp(from, to, easing(t)));
    if (t < 1) id = requestAnimationFrame(step); else finish(to);
  };
  id = requestAnimationFrame(step);
  return { finish, cancel() { done = true; cancelAnimationFrame(id); }, get done() { return done; } };
}

export const fmtSize = n => n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
export function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return sec <= 0 ? '0 分钟' : '不到 1 分钟';
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}
export function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts, m = d / 60000;
  if (m < 1) return '刚刚';
  if (m < 60) return Math.floor(m) + ' 分钟前';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (ts >= today) return Math.floor(m / 60) + ' 小时前';
  const days = Math.ceil((today - ts) / 864e5);
  if (days === 1) return '昨天';
  if (days < 7) return days + ' 天前';
  const dt = new Date(ts);
  return dt.getFullYear() === today.getFullYear() ? `${dt.getMonth() + 1} 月 ${dt.getDate()} 日` : `${dt.getFullYear()} 年 ${dt.getMonth() + 1} 月`;
}
export const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const pct = v => (v * 100 < 10 && v > 0 ? (v * 100).toFixed(1) : Math.round(v * 100)) + '%';
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export async function contentId(blob) {
  const head = await blob.slice(0, 262144).arrayBuffer();
  const pre = new TextEncoder().encode(String(blob.size));
  const all = new Uint8Array(pre.length + head.byteLength); all.set(pre); all.set(new Uint8Array(head), pre.length);
  const d = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// 拼音首字母：借助中文排序规则二分，零字典
const PY_B = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀';
const PY_L = 'ABCDEFGHJKLMNOPQRSTWXYZ';
const coll = new Intl.Collator('zh-Hans-CN');
const pyCache = new Map();
function initialOf(ch) {
  if (pyCache.has(ch)) return pyCache.get(ch);
  let r = ch.toLowerCase();
  if (/[一-鿿]/.test(ch)) {
    r = '';
    for (let i = PY_B.length - 1; i >= 0; i--) if (coll.compare(ch, PY_B[i]) >= 0) { r = PY_L[i].toLowerCase(); break; }
  }
  pyCache.set(ch, r);
  return r;
}
export const initials = s => [...String(s)].map(initialOf).join('');

// 模糊匹配：子串 > 首字母 > 子序列；返回分数与命中区间
export function fuzzy(q, text) {
  if (!q) return { score: 1, ranges: [] };
  const t = String(text || ''), tl = t.toLowerCase(), ql = q.toLowerCase();
  let i = tl.indexOf(ql);
  if (i >= 0) return { score: 100 - i * .5 + (i === 0 ? 20 : 0) + ql.length, ranges: [[i, i + ql.length]] };
  const ini = initials(t);
  if (/^[a-z]+$/.test(ql)) {
    i = ini.indexOf(ql);
    if (i >= 0) return { score: 70 - i * .5 + ql.length, ranges: [...Array(ql.length)].map((_, k) => [i + k, i + k + 1]) };
  }
  // 子序列（允许拼音首字母）
  const ranges = []; let j = 0, gaps = 0, last = -1;
  for (let k = 0; k < t.length && j < ql.length; k++) {
    if (tl[k] === ql[j] || ini[k] === ql[j]) { if (last >= 0 && k - last > 1) gaps++; ranges.push([k, k + 1]); last = k; j++; }
  }
  if (j === ql.length && ql.length > 2 && gaps <= Math.max(1, ql.length / 2)) return { score: 40 - gaps * 4 - ranges[0][0] * .2, ranges };
  return null;
}
export function markRanges(text, ranges) {
  if (!ranges?.length) return esc(text);
  let out = '', pos = 0;
  for (const [a, b] of ranges) { out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; pos = b; }
  return out + esc(text.slice(pos));
}

// 轻提示
let toastEl, toastTimer;
export function toast(msg, { action, onAction, duration = 2600 } = {}) {
  if (!toastEl) { toastEl = h('div', { class: 'toast', role: 'status' }); document.body.append(toastEl); }
  toastEl.replaceChildren(...[h('span', null, msg), action ? h('button', { class: 'toast-act', onclick: () => { onAction?.(); hideToast(); } }, action) : null].filter(Boolean));
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}
export function hideToast() { toastEl?.classList.remove('show'); }

// 线性图标（统一 1.6 描边，跟随 currentColor）
const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  toc: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  bookmark: '<path d="M7 3.5h10v17l-5-3.6-5 3.6z"/>',
  bookmarkFill: '<path d="M7 3.5h10v17l-5-3.6-5 3.6z" fill="currentColor"/>',
  type: '<path d="M4 19l5-14 5 14M5.8 14h6.4M15 19l3-8 3 8M15.9 16.6h4.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".9" fill="currentColor"/><circle cx="4.5" cy="12" r=".9" fill="currentColor"/><circle cx="4.5" cy="18" r=".9" fill="currentColor"/>',
  sort: '<path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  file: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H12"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M8.5 11h5M11 8.5v5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M8.5 11h5"/>',
  highlight: '<path d="M4 20h7M14.5 4.5l5 5-8.5 8.5H6v-5z"/>',
  note: '<path d="M5 4.5h14v11l-4.5 4.5H5z"/><path d="M14.5 20v-4.5H19"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M5 15.5V5.5A1.5 1.5 0 0 1 6.5 4H15"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.7 4.7 0 0 0 7 18.5z"/>',
  device: '<rect x="6.5" y="3" width="11" height="18" rx="2"/><path d="M11 18h2"/>',
  logout: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 8l-4 4 4 4M6 12h10"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  crop: '<path d="M7 3v14h14M3 7h14v14"/>',
  text: '<path d="M5 6h14M5 10h14M5 14h14M5 18h9"/>',
  page: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/>',
  pages: '<rect x="2.5" y="4" width="9" height="16" rx="1.2"/><rect x="12.5" y="4" width="9" height="16" rx="1.2"/>',
  scroll: '<rect x="6" y="2.5" width="12" height="8" rx="1.2"/><rect x="6" y="13.5" width="12" height="8" rx="1.2"/>',
};
export const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
export const iconEl = (name, cls) => { const t = document.createElement('template'); t.innerHTML = icon(name, cls); return t.content.firstChild; };

// 文件选择
export function pickFiles({ accept = '', multiple = true, directory = false } = {}) {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    if (directory) input.webkitdirectory = true;
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function onLongPress(el, fn, ms = 520) {
  let t, sx, sy;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    sx = e.clientX; sy = e.clientY;
    t = setTimeout(() => { el.dataset.longpressed = '1'; navigator.vibrate?.(8); fn(e); }, ms);
  });
  const cancel = () => clearTimeout(t);
  el.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
  el.addEventListener('pointerup', cancel); el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', e => { e.preventDefault(); if (!el.dataset.longpressed) fn(e); });
  el.addEventListener('click', e => { if (el.dataset.longpressed) { e.stopPropagation(); e.preventDefault(); delete el.dataset.longpressed; } }, true);
}
