// 入口：恢复状态、书架与阅读器之间的往返、深链接（刷新后回到正在读的书）
import { $, toast, sleep } from './util.js';
import { store } from './store.js';
import { Library } from './library.js';
import { Reader } from './reader.js';
import { openBook, closeBook } from './opener.js';
import { applyTheme, watchTime, THEMES, effectiveTheme } from './theme.js';

const libRoot = $('#library'), readRoot = $('#reader');
let library, reader, current = null, coverEl = null, libY = 0;

const paperColor = () => THEMES.find(t => t.id === effectiveTheme(store.settings)).paper;

async function open(book, fromCover, { push = true, animate = true } = {}) {
  if (!book) return;
  if (current) await reader.close();
  current = book; coverEl = fromCover;
  if (push) history.pushState({ book: book.id }, '', '#/b/' + book.id);
  let firstPaint;
  const painted = new Promise(r => { firstPaint = r; });
  if (animate) readRoot.classList.add('pre-open');
  const opening = reader.open(book, { onFirstPaint: firstPaint }).catch(e => { console.error(e); });
  if (animate) await openBook(fromCover, paperColor(), painted, () => readRoot.classList.remove('pre-open'));
  else await painted;
  readRoot.classList.remove('pre-open');
  libRoot.inert = true;
  // 阅读时把书架整个收起：手机浏览器里，身后那张长长的书架会被手指带着滚动、缩放
  libY = scrollY;
  libRoot.classList.add('behind');
  await opening;
}

async function close({ fromPop = false } = {}) {
  if (!current) return;
  const id = current.id;
  current = null;
  libRoot.inert = false;
  libRoot.classList.remove('behind');
  library.render();
  scrollTo(0, libY);
  await sleep(0);
  const target = document.querySelector(`.book[data-key="${id}"] .cover, .hero-main[data-id="${id}"] .cover`) || coverEl;
  const p = paperColor();
  readRoot.classList.add('leaving');
  const anim = closeBook(target, p);
  await reader.close();
  readRoot.classList.remove('leaving');
  await anim;
  if (!fromPop && location.hash.startsWith('#/b/')) history.back();
}

function route() {
  const m = /^#\/b\/([\w-]+)/.exec(location.hash);
  if (m && (!current || current.id !== m[1])) {
    const b = store.books.get(m[1]);
    if (b) open(b, null, { push: false, animate: false });
  } else if (!m && current) close({ fromPop: true });
}

async function boot() {
  await store.init();
  applyTheme(store.settings);
  watchTime(() => store.settings);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.settings));
  library = new Library(libRoot, { onOpen: (b, el) => open(b, el) });
  reader = new Reader(readRoot);
  reader.onExit = () => close();
  window.__zb = { store, reader, library };
  library.render();
  document.documentElement.classList.add('ready');
  store.on('books', () => { if (!current) library.render(); });
  store.on('states', () => { if (!current) library.render(); });
  store.on('auth', () => library.render());
  store.on('settings', (s, remote, patch = {}) => {
    applyTheme(s);
    if (current) reader.onSettings(s, remote, remote ? Object.keys(s).reduce((o, k) => (o[k] = s[k], o), {}) : patch);
  });
  addEventListener('popstate', route);
  if (location.hash.startsWith('#/b/')) {
    // 等云端书目到位再打开
    for (let i = 0; i < 40 && !store.books.get(location.hash.slice(4)); i++) await sleep(100);
    route();
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (store.offline) toast('离线中：本机书籍仍可阅读');
}
boot();
