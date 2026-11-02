// 开书 / 合书：封面从书架浮起、居中、翻开封皮，纸页铺满屏幕；合上时原路回到书架
import { h, reducedMotion, sleep } from './util.js';

const EASE = 'cubic-bezier(.22,.75,.18,1)';

function centerRect(r) {
  const vw = innerWidth, vh = innerHeight;
  const a = r.width / r.height || .7;
  const hh = Math.min(vh * .62, 560, (vw * .56) / a);
  const w = hh * a;
  return { left: (vw - w) / 2 + w * .08, top: (vh - hh) / 2, width: w, height: hh };
}
const tf = (from, to) => `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;

export async function openBook(coverEl, paper, ready, reveal) {
  const src = coverEl?.isConnected ? coverEl : null;
  const r = src?.getBoundingClientRect();
  if (!src || reducedMotion() || !r.width || r.bottom < 0 || r.top > innerHeight) {
    const veil = h('div', { class: 'opener veil', style: { background: paper } });
    document.body.append(veil);
    veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: 'forwards' });
    await ready; reveal?.();
    await veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' }).finished;
    veil.remove();
    return;
  }
  const C = centerRect(r);
  const full = { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const stage = h('div', { class: 'opener' });
  const page = h('div', { class: 'o-page', style: { background: paper } });
  const book = h('div', { class: 'o-book' });
  const cover = h('div', { class: 'o-cover' });
  const front = src.cloneNode(true); front.classList.add('o-front');
  const inside = h('div', { class: 'o-inside' });
  cover.append(front, inside);
  const pageIn = h('div', { class: 'o-leaf', style: { background: paper } }, h('i'));
  book.append(pageIn, cover);
  Object.assign(book.style, { left: C.left + 'px', top: C.top + 'px', width: C.width + 'px', height: C.height + 'px' });
  Object.assign(page.style, { left: 0, top: 0, width: innerWidth + 'px', height: innerHeight + 'px' });
  stage.append(page, book);
  document.body.append(stage);
  src.style.visibility = 'hidden';

  // 1 浮起至中央
  const lift = book.animate([{ transform: tf(r, C), boxShadow: '0 2px 6px rgba(0,0,0,.12)' }, { transform: 'none', boxShadow: '0 30px 60px -20px rgba(0,0,0,.45)' }], { duration: 380, easing: EASE, fill: 'forwards' });
  stage.animate([{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--scrim-strong').trim() || 'rgba(0,0,0,.4)' }], { duration: 380, fill: 'forwards' });
  await sleep(200);
  // 2 翻开封皮
  const turn = cover.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-168deg)' }], { duration: 560, easing: 'cubic-bezier(.45,.05,.25,1)', fill: 'forwards' });
  inside.animate([{ opacity: .0 }, { opacity: 1 }], { duration: 560, fill: 'forwards' });
  await lift.finished;
  await sleep(260);
  // 3 纸页铺满
  const Cb = book.getBoundingClientRect();
  page.style.opacity = 1;
  const grow = page.animate([{ transform: tf(Cb, full), borderRadius: '3px' }, { transform: 'none', borderRadius: '0px' }], { duration: 420, easing: EASE, fill: 'forwards' });
  book.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 80, fill: 'forwards' });
  await grow.finished;
  turn.cancel?.();
  src.style.visibility = '';
  await Promise.race([ready, sleep(12000)]);
  reveal?.();
  await stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out', fill: 'forwards' }).finished;
  stage.remove();
}

export async function closeBook(coverEl, paper) {
  const target = coverEl?.isConnected ? coverEl : null;
  const r = target?.getBoundingClientRect();
  const visible = r && r.width && r.bottom > 0 && r.top < innerHeight;
  const stage = h('div', { class: 'opener closing' });
  const page = h('div', { class: 'o-page', style: { background: paper, left: 0, top: 0, width: innerWidth + 'px', height: innerHeight + 'px', opacity: 1 } });
  stage.append(page);
  document.body.append(stage);
  if (!visible || reducedMotion()) {
    await page.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out', fill: 'forwards' }).finished;
    stage.remove(); return;
  }
  const full = { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const front = target.cloneNode(true); front.classList.add('o-front');
  const ghost = h('div', { class: 'o-book back' }, front);
  Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', opacity: 0 });
  stage.append(ghost);
  target.style.visibility = 'hidden';
  const shrink = page.animate([{ transform: 'none', borderRadius: '0px' }, { transform: tf(r, full), borderRadius: '4px' }], { duration: 420, easing: EASE, fill: 'forwards' });
  ghost.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 200, fill: 'forwards' });
  await shrink.finished;
  target.style.visibility = '';
  await stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished;
  stage.remove();
}
