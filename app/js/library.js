// 书架：继续阅读、分类、即时搜索（含拼音首字母）、丛书叠放、导入、书籍详情
import { h, $, $$, icon, clamp, debounce, toast, fmtSize, fmtDuration, pct, relTime, fuzzy, markRanges, strHash, pickFiles, onLongPress, isTouch, esc, sleep } from './util.js';
import { store, api } from './store.js';
import { ACCEPT, formatOf, peekMeta } from './formats.js';
import { toggleNight } from './reader.js';
import { THEMES, effectiveTheme } from './theme.js';

const coll = new Intl.Collator('zh-Hans-CN', { numeric: true });
const PALETTE = [['#3F5566', '#E9E4D8'], ['#8A5136', '#F2E6D6'], ['#3D6A63', '#E6EFEA'], ['#6E5A73', '#EEE6EE'], ['#A48B4F', '#FAF3E2'], ['#56664E', '#ECF0E4'], ['#2F2E2C', '#E8E4DA'], ['#7F3540', '#F4E5E4'], ['#4E6A86', '#E6EDF3'], ['#8C7A5B', '#F5EFE3']];
const FORMAT_NAME = { pdf: 'PDF', epub: 'EPUB', mobi: 'Kindle', fb2: 'FB2', txt: 'TXT', md: 'Markdown', html: 'HTML', docx: 'Word', doc: 'Word', cbz: '漫画' };
const LOCAL_CAT = '本机';

export class Library {
  constructor(root, { onOpen }) {
    this.root = root; this.onOpen = onOpen;
    this.cat = localStorage.getItem('zb-cat') || '全部';
    this.q = '';
    this.urls = new Map();
    root.innerHTML = TEMPLATE;
    this.ui = Object.fromEntries($$('[data-ref]', root).map(e => [e.dataset.ref, e]));
    this.cards = new Map();
    this.#wire();
  }

  // ---------- 数据 ----------
  #books() { return [...store.books.values()]; }
  #lastRead(b) { return store.state(b.id).progress?.t || 0; }
  #prog(b) { return store.state(b.id).progress?.pct || 0; }
  #finished(b) { const p = store.state(b.id).progress; return !!(p?.finished || p?.pct >= .995); }
  #items() {
    const series = new Map(), out = [];
    for (const b of this.#books()) {
      if (b.series) {
        let s = series.get(b.series);
        if (!s) { s = { type: 'series', key: 's:' + b.series, title: b.series, author: b.author, category: b.category, books: [] }; series.set(b.series, s); out.push(s); }
        s.books.push(b);
      } else out.push({ type: 'book', key: b.id, book: b, title: b.title, author: b.author, category: b.category });
    }
    for (const s of series.values()) {
      s.books.sort((a, b) => (a.volume ?? 999) - (b.volume ?? 999) || coll.compare(a.title, b.title));
      if (s.books.length === 1) { const b = s.books[0]; Object.assign(s, { type: 'book', key: b.id, book: b, title: b.title }); delete s.books; }
    }
    return out;
  }
  #lastOf(it) { return it.type === 'book' ? this.#lastRead(it.book) : Math.max(0, ...it.books.map(b => this.#lastRead(b))); }
  #addedOf(it) { return it.type === 'book' ? it.book.added || 0 : Math.max(0, ...it.books.map(b => b.added || 0)); }
  #progOf(it) { return it.type === 'book' ? this.#prog(it.book) : it.books.reduce((a, b) => a + this.#prog(b), 0) / it.books.length; }
  #catOf(it) { return it.category || ''; }
  #isLocalOnly(it) { return it.type === 'book' ? it.book.local && !it.book.cloud : it.books.every(b => b.local && !b.cloud); }
  #categories(items) {
    const counts = new Map([['全部', items.length]]);
    const order = [...store.categories];
    for (const it of items) { const c = this.#catOf(it) || '未分类'; if (!order.includes(c)) order.push(c); counts.set(c, (counts.get(c) || 0) + 1); }
    const local = items.filter(it => this.#isLocalOnly(it)).length;
    const cats = ['全部', ...order.filter(c => counts.get(c))];
    if (local) { cats.push(LOCAL_CAT); counts.set(LOCAL_CAT, local); }
    return { cats, counts };
  }

  // ---------- 渲染 ----------
  render() {
    const items = this.#items();
    const total = this.#books().length;
    this.root.classList.toggle('empty', total === 0);
    this.ui.welcome.hidden = total > 0;
    if (!total) this.#renderWelcome();
    this.#renderGreeting();
    this.#renderHero();
    const { cats, counts } = this.#categories(items);
    if (!cats.includes(this.cat)) this.cat = '全部';
    this.ui.cats.replaceChildren(...cats.map(c => h('button', { class: 'cat' + (c === this.cat ? ' on' : ''), dataset: { cat: c }, role: 'tab', 'aria-selected': c === this.cat, onclick: () => this.setCat(c) }, h('span', null, c), h('i', null, counts.get(c)))), h('span', { class: 'cat-ink', 'aria-hidden': 'true' }));
    this.#syncCards(items);
    this.#apply(false);
    requestAnimationFrame(() => this.#moveInk(false));
    this.ui.foot.textContent = total ? `${total} 本书` + (store.authed ? ' · 云端书库已连接' : store.books.size ? ' · 仅本机' : '') : '';
    this.#renderAccount();
  }

  #renderGreeting() {
    const d = new Date(), hr = d.getHours();
    const part = hr < 5 ? '夜深了' : hr < 9 ? '清晨' : hr < 12 ? '上午' : hr < 14 ? '正午' : hr < 18 ? '午后' : hr < 20 ? '傍晚' : hr < 23 ? '入夜' : '夜深了';
    const wk = '日一二三四五六'[d.getDay()];
    const today = store.todayTime();
    const late = hr >= 23 || hr < 5;
    this.ui.greet.innerHTML = esc(`${d.getMonth() + 1} 月 ${d.getDate()} 日`) + `<span class="wk"> · 星期${wk}</span> · ` + esc(part) + (today >= 60 ? esc(` · 今日已读 ${fmtDuration(today)}`) : '') + (late && today > 1200 ? '，早些休息' : '');
  }

  #renderHero() {
    const reading = this.#books().filter(b => this.#lastRead(b) && !this.#finished(b)).sort((a, b) => this.#lastRead(b) - this.#lastRead(a));
    const hero = this.ui.hero;
    if (!reading.length) { hero.replaceChildren(); hero.hidden = true; return; }
    hero.hidden = false;
    const [b, ...rest] = reading;
    const st = store.state(b.id).progress;
    const main = h('article', { class: 'hero-main', tabindex: 0, dataset: { id: b.id } },
      h('div', { class: 'hero-book' }, this.cover(b, 'lg')),
      h('div', { class: 'hero-info' },
        h('span', { class: 'eyebrow' }, '继续阅读'),
        h('h2', null, b.title),
        b.author ? h('p', { class: 'by' }, b.author) : null,
        h('div', { class: 'hero-prog' }, h('div', { class: 'hbar' }, h('i', { style: { width: (st.pct * 100).toFixed(1) + '%' } })), h('span', null, pct(st.pct))),
        h('p', { class: 'where' }, [st.label, relTime(st.t)].filter(Boolean).join(' · ')),
        h('button', { class: 'btn', html: icon('play') + '<span>继续</span>', onclick: e => { e.stopPropagation(); this.onOpen(b, $('.cover', main)); } })));
    main.addEventListener('click', () => this.onOpen(b, $('.cover', main)));
    main.addEventListener('keydown', e => e.key === 'Enter' && this.onOpen(b, $('.cover', main)));
    const mini = rest.slice(0, 6).map(x => {
      const el = h('button', { class: 'hero-mini', title: x.title }, this.cover(x, 'sm'), h('span', { class: 't' }, x.title), h('span', { class: 'p' }, pct(this.#prog(x))));
      el.onclick = () => this.onOpen(x, $('.cover', el));
      return el;
    });
    hero.replaceChildren(main, mini.length ? h('div', { class: 'hero-rest' }, h('span', { class: 'eyebrow' }, '也在读'), h('div', { class: 'hero-rest-list' }, mini)) : '');
  }

  #syncCards(items) {
    const keep = new Set();
    for (const it of items) {
      keep.add(it.key);
      const sig = JSON.stringify([it.title, it.author, it.type === 'book' ? [it.book.cover, it.book.localCover, this.#prog(it.book), this.#finished(it.book)] : it.books.map(b => [b.id, b.cover, this.#prog(b)])]);
      let c = this.cards.get(it.key);
      if (!c || c.sig !== sig) {
        const el = this.#card(it);
        if (c) c.el.replaceWith(el); else this.ui.shelf.append(el);
        c = { el, sig, it }; this.cards.set(it.key, c);
      }
      c.it = it;
    }
    for (const [k, c] of this.cards) if (!keep.has(k)) { c.el.remove(); this.cards.delete(k); }
  }

  #card(it) {
    const isSeries = it.type === 'series';
    const b = isSeries ? it.books[0] : it.book;
    const p = this.#progOf(it), done = !isSeries && this.#finished(b);
    const coverWrap = h('div', { class: 'cover-wrap' + (isSeries ? ' stack' : '') });
    if (isSeries) {
      it.books.slice(0, 3).reverse().forEach((x, i, arr) => { const c = this.cover(x); c.style.setProperty('--k', arr.length - 1 - i); coverWrap.append(c); });
      coverWrap.append(h('span', { class: 'vols' }, `${it.books.length} 卷`));
    } else coverWrap.append(this.cover(b));
    if (p > 0 && !done) coverWrap.append(h('div', { class: 'prog', style: { '--p': p } }));
    if (done) coverWrap.append(h('span', { class: 'done', html: icon('check') }));
    if (!isSeries && b.local && !b.cloud) coverWrap.append(h('span', { class: 'badge-local', title: '仅在本机', html: icon('device') }));
    const el = h('article', { class: 'book' + (isSeries ? ' series' : ''), tabindex: 0, dataset: { key: it.key }, role: 'button', 'aria-label': it.title },
      coverWrap,
      h('div', { class: 'meta' }, h('h3', { class: 't' }, it.title), h('p', { class: 'a' }, isSeries ? `${it.author || ''}${it.author ? ' · ' : ''}${it.books.length} 卷` : [it.author, p > 0 && !done ? pct(p) : ''].filter(Boolean).join(' · ') || FORMAT_NAME[b.format] || '')));
    const open = () => isSeries ? this.#openSeries(it, el) : this.onOpen(b, $('.cover', el));
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    onLongPress(el, () => isSeries ? this.#openSeries(it, el) : this.showInfo(b));
    if (!isTouch) tilt(el);
    return el;
  }

  cover(b, size = '') {
    const box = h('div', { class: 'cover ' + size });
    const gen = () => { box.classList.add('gen'); box.replaceChildren(...genCover(b)); const [c1, c2] = PALETTE[strHash(b.title) % PALETTE.length]; box.style.setProperty('--c1', c1); box.style.setProperty('--c2', c2); };
    const useImg = src => {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
      img.onload = () => box.classList.add('loaded');
      img.onerror = () => { img.remove(); gen(); };
      img.src = src; box.append(img);
    };
    if (b.cover && b.cloud) useImg(api.coverUrl(b.id));
    else if (b.localCover) {
      if (this.urls.has(b.id)) useImg(this.urls.get(b.id));
      else { gen(); store.coverBlob(b.id).then(bl => { if (!bl) return; const u = URL.createObjectURL(bl); this.urls.set(b.id, u); box.classList.remove('gen'); box.replaceChildren(); box.removeAttribute('style'); useImg(u); }); }
    } else gen();
    return box;
  }

  // ---------- 筛选 + 流动动画 ----------
  setCat(c) {
    if (c === this.cat) return;
    this.cat = c; localStorage.setItem('zb-cat', c);
    $$('.cat', this.ui.cats).forEach(b => { const on = b.dataset.cat === c; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    this.#moveInk(true);
    this.#apply(true);
    $('.cat.on', this.ui.cats)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  #moveInk(animate) {
    const ink = $('.cat-ink', this.ui.cats), on = $('.cat.on', this.ui.cats);
    if (!ink || !on) return;
    ink.style.transition = animate ? '' : 'none';
    ink.style.width = on.offsetWidth + 'px'; ink.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  #match(it) {
    const q = this.q;
    if (this.cat === LOCAL_CAT ? !this.#isLocalOnly(it) : this.cat !== '全部' && (this.#catOf(it) || '未分类') !== this.cat) return null;
    if (!q) return { score: 0 };
    const fields = [[it.title, 1], [it.author, .7], [it.category, .4], ...(it.books || []).map(b => [b.title, .8])];
    let best = null;
    for (const [text, w] of fields) { const m = fuzzy(q, text); if (m && (!best || m.score * w > best.score)) best = { score: m.score * w, ranges: text === it.title ? m.ranges : best?.ranges, field: text }; }
    if (best && !best.ranges) { const m = fuzzy(q, it.title); best.ranges = m?.ranges || []; }
    return best;
  }
  #groups(shown) {
    const order = [...store.categories], map = new Map();
    for (const c of shown) { const k = this.#catOf(c.it) || '未分类'; if (!map.has(k)) map.set(k, []); map.get(k).push(c); }
    if (map.size < 2) return null;
    const rank = k => k === '未分类' ? 1e4 : order.includes(k) ? order.indexOf(k) : 1e3;
    return [...map].sort((a, b) => rank(a[0]) - rank(b[0]) || coll.compare(a[0], b[0]));
  }
  #sortKey(a, b) {
    const s = store.settings.sort;
    if (s === 'title') return coll.compare(a.it.title, b.it.title);
    if (s === 'added') return this.#addedOf(b.it) - this.#addedOf(a.it);
    if (s === 'progress') return this.#progOf(b.it) - this.#progOf(a.it) || this.#lastOf(b.it) - this.#lastOf(a.it);
    return this.#lastOf(b.it) - this.#lastOf(a.it) || this.#addedOf(b.it) - this.#addedOf(a.it) || coll.compare(a.it.title, b.it.title);
  }
  #apply(animate) {
    const shelf = this.ui.shelf;
    const cards = [...this.cards.values()];
    const first = new Map();
    if (animate) for (const c of cards) if (!c.el.hidden) first.set(c, c.el.getBoundingClientRect());
    const shown = [];
    for (const c of cards) { const m = this.#match(c.it); c.m = m; if (m) shown.push(c); }
    shown.sort((a, b) => this.q ? b.m.score - a.m.score : this.#sortKey(a, b));
    const hidden = cards.filter(c => !c.m);
    // 「全部」之下按类分组：每一类有自己的题签，书架的秩序一眼可见
    $$('.shelf-group', shelf).forEach(g => g.remove());
    const groups = this.cat === '全部' && !this.q ? this.#groups(shown) : null;
    if (groups) for (const [name, list] of groups) {
      shelf.append(h('h2', { class: 'shelf-group' }, h('button', { onclick: () => { this.setCat(name); this.ui.cats.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, h('span', null, name), h('i', null, list.length), h('em', { html: icon('chevron') }))));
      for (const c of list) shelf.append(c.el);
    } else for (const c of shown) shelf.append(c.el);
    for (const c of hidden) shelf.append(c.el);
    for (const c of cards) {
      const t = $('.meta .t', c.el);
      t.innerHTML = this.q && c.m?.ranges?.length ? markRanges(c.it.title, c.m.ranges) : esc(c.it.title);
    }
    const leaving = hidden.filter(c => !c.el.hidden);
    for (const c of hidden) c.el.hidden = true;
    for (const c of shown) c.el.hidden = false;
    this.root.classList.toggle('searching', !!this.q);
    this.ui.none.hidden = shown.length > 0 || !cards.length;
    if (!shown.length && cards.length) this.ui.none.innerHTML = this.q ? `没有找到「${esc(this.q)}」<small>可试试拼音首字母，比如 xlx → 心理学</small>` : '这一类还没有书';
    this.ui.count.textContent = this.q ? `${shown.length} 本` : '';
    if (!animate || document.documentElement.classList.contains('calm')) return;
    // FLIP：留下的平移到新位置，新出现的从水中浮起，离开的淡出
    const shelfRect = shelf.getBoundingClientRect();
    shown.forEach((c, i) => {
      const a = first.get(c), b = c.el.getBoundingClientRect();
      if (a) {
        const dx = a.left - b.left, dy = a.top - b.top;
        if (dx || dy) c.el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' });
      } else c.el.animate([{ opacity: 0, transform: 'translateY(14px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 380, delay: Math.min(i, 14) * 18, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
    });
    for (const c of leaving) {
      const a = first.get(c); if (!a) continue;
      const ghost = c.el.cloneNode(true); ghost.hidden = false; ghost.classList.add('ghost');
      Object.assign(ghost.style, { position: 'absolute', left: a.left - shelfRect.left + 'px', top: a.top - shelfRect.top + 'px', width: a.width + 'px', pointerEvents: 'none', margin: 0 });
      shelf.append(ghost);
      ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 220, easing: 'ease-out' }).onfinish = () => ghost.remove();
    }
  }

  // ---------- 丛书 ----------
  #openSeries(it, from) {
    const grid = h('div', { class: 'shelf series-grid' });
    for (const b of it.books) {
      const p = this.#prog(b), done = this.#finished(b);
      const wrap = h('div', { class: 'cover-wrap' }, this.cover(b));
      if (p > 0 && !done) wrap.append(h('div', { class: 'prog', style: { '--p': p } }));
      if (done) wrap.append(h('span', { class: 'done', html: icon('check') }));
      const card = h('article', { class: 'book', tabindex: 0 }, wrap, h('div', { class: 'meta' }, h('h3', { class: 't' }, b.title.replace(it.title, '').replace(/^\s*[·:：-]\s*/, '') || b.title), h('p', { class: 'a' }, [FORMAT_NAME[b.format], b.pages ? b.pages + ' 页' : '', p > 0 && !done ? pct(p) : ''].filter(Boolean).join(' · '))));
      card.onclick = () => { this.closeSheet(); this.onOpen(b, $('.cover', card)); };
      onLongPress(card, () => { this.closeSheet(); this.showInfo(b); });
      grid.append(card);
    }
    this.openSheet(h('div', { class: 'series-sheet' }, h('div', { class: 'sheet-head' }, h('div', null, h('b', null, it.title), h('span', null, [it.author, `${it.books.length} 卷`].filter(Boolean).join(' · '))), closeBtn(() => this.closeSheet())), grid), 'wide');
  }

  // ---------- 详情 ----------
  showInfo(b) {
    const st = store.state(b.id), p = st.progress?.pct || 0, time = store.readingTime(b.id);
    const cats = [...new Set([...store.categories, ...this.#books().map(x => x.category).filter(Boolean)])];
    const title = h('input', { class: 'inline-edit', value: b.title, 'aria-label': '书名' });
    const author = h('input', { class: 'inline-edit sm', value: b.author || '', placeholder: '作者', 'aria-label': '作者' });
    const cat = h('select', { class: 'select', 'aria-label': '分类' }, h('option', { value: '' }, '未分类'), cats.map(c => h('option', { value: c, selected: c === b.category }, c)), h('option', { value: '__new' }, '新分类…'));
    const save = async () => {
      let category = cat.value;
      if (category === '__new') { category = (prompt('新分类名称') || '').trim(); if (!category) { cat.value = b.category || ''; return; } }
      const patch = {};
      if (title.value.trim() && title.value.trim() !== b.title) patch.title = title.value.trim();
      if (author.value.trim() !== (b.author || '')) patch.author = author.value.trim();
      if (category !== (b.category || '')) patch.category = category;
      if (Object.keys(patch).length) { await store.updateMeta(b.id, patch); toast('已更新'); }
    };
    title.onchange = save; author.onchange = save; cat.onchange = save;
    const facts = [
      ['格式', FORMAT_NAME[b.format] || b.format], ['大小', fmtSize(b.size || 0)], b.pages ? ['页数', b.pages + ' 页'] : null,
      ['来源', b.cloud && b.local ? '云端 · 本机已存' : b.cloud ? '云端书库' : '仅本机'],
      ['进度', p ? pct(p) + (st.progress?.label ? ' · ' + st.progress.label : '') : '未读'],
      time ? ['用时', fmtDuration(time)] : null,
      st.progress?.t ? ['上次', relTime(st.progress.t)] : null,
      b.added ? ['加入', new Date(b.added).toLocaleDateString('zh-CN')] : null,
      (st.marks?.items?.length || st.notes?.items?.length) ? ['札记', `${st.marks?.items?.length || 0} 书签 · ${st.notes?.items?.length || 0} 划线`] : null,
    ].filter(Boolean);
    const acts = h('div', { class: 'info-acts' },
      h('button', { class: 'btn', html: icon('play') + `<span>${p ? '继续阅读' : '开始阅读'}</span>`, onclick: () => { this.closeSheet(); this.onOpen(b, null); } }),
      p ? h('button', { class: 'btn ghost', onclick: () => { store.setProgress(b.id, { pos: null, pct: 0, label: '' }); this.closeSheet(); this.onOpen(b, null); } }, '从头读') : null,
      b.local && !b.cloud && store.authed ? h('button', { class: 'btn ghost', html: icon('cloud') + '<span>存入云端</span>', onclick: async () => { const f = await store.localFile(b.id); if (f) { this.closeSheet(); this.#upload([new File([f], b.name || `${b.title}.${b.format}`)]); } } }) : null,
      b.local ? h('button', { class: 'btn ghost danger', html: icon('trash') + `<span>${b.cloud ? '删除本机副本' : '从本机移除'}</span>`, onclick: async () => { if (!b.cloud && !confirm(`从本机移除《${b.title}》？阅读记录会保留。`)) return; await store.removeLocal(b.id); this.closeSheet(); toast('已移除'); } }) : null,
      b.cloud && store.authed ? h('button', { class: 'btn ghost danger', html: icon('trash') + '<span>移出云端书库</span>', onclick: async () => { if (!confirm(`将《${b.title}》移出云端书库？\n文件会移到服务器的回收目录，可找回。`)) return; try { await api.remove(b.id); await store.refresh(); this.closeSheet(); toast('已移出'); } catch (e) { toast('操作失败：' + e.message); } } }) : null,
    );
    this.openSheet(h('div', { class: 'info' },
      h('div', { class: 'info-top' }, h('div', { class: 'info-cover' }, this.cover(b, 'lg')), h('div', { class: 'info-main' }, title, author, h('label', { class: 'cat-pick' }, h('span', null, '分类'), cat))),
      h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      acts), 'info-sheet');
  }

  // ---------- 通用抽屉 ----------
  openSheet(content, cls = '') {
    const sh = this.ui.sheet;
    sh.className = 'lib-sheet ' + cls;
    sh.replaceChildren(h('div', { class: 'grab' }), content);
    sh.scrollTop = 0;
    this.#lockPage(true);
    this.root.classList.add('sheet-open');
    requestAnimationFrame(() => sh.classList.add('open'));
    sh.focus({ preventScroll: true });
  }
  closeSheet() {
    const sh = this.ui.sheet;
    sh.classList.remove('open'); sh.style.transform = ''; this.root.classList.remove('sheet-open');
    this.#lockPage(false);
  }
  // 弹层打开时把身后的书架钉住：手机上指尖在弹层里滑动，不会再带着书架一起走
  #lockPage(on) {
    const b = document.body;
    if (on && this.lockY == null) { this.lockY = scrollY; Object.assign(b.style, { position: 'fixed', top: -this.lockY + 'px', left: '0', right: '0' }); }
    else if (!on && this.lockY != null) { const y = this.lockY; this.lockY = null; Object.assign(b.style, { position: '', top: '', left: '', right: '' }); scrollTo(0, y); }
  }
  // 手机上按住把手或标题往下拉，即可收起
  #sheetDrag() {
    const sh = this.ui.sheet; let g = null;
    sh.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || innerWidth >= 760 || !e.target.closest('.grab, .sheet-head') || e.target.closest('button, input, select')) return;
      g = { y0: e.clientY, id: e.pointerId, t0: performance.now(), dy: 0 };
      try { sh.setPointerCapture(e.pointerId); } catch {}
      sh.style.transition = 'none';
    });
    sh.addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      g.dy = Math.max(0, e.clientY - g.y0);
      sh.style.transform = `translateY(${g.dy}px)`;
    });
    const end = e => {
      if (!g || e.pointerId !== g.id) return;
      const { dy, t0 } = g; g = null;
      sh.style.transition = '';
      if (dy > 110 || (dy > 40 && dy / (performance.now() - t0) > .5)) this.closeSheet(); else sh.style.transform = '';
    };
    sh.addEventListener('pointerup', end); sh.addEventListener('pointercancel', end);
  }

  // ---------- 导入 ----------
  async import(files) {
    files = files.filter(f => formatOf(f.name));
    if (!files.length) { toast('没有可识别的书籍文件'); return; }
    const toCloud = store.authed && localStorage.getItem('zb-upload') !== '0';
    if (toCloud) return this.#upload(files);
    let added = 0, dup = 0;
    const tray = this.#tray(`正在放上书架 0 / ${files.length}`);
    for (const [i, f] of files.entries()) {
      try {
        const meta = await peekMeta(f);
        const { id, existed } = await store.addLocal(f, meta);
        if (existed) dup++; else { added++; if (meta.cover) await store.saveCover(id, meta.cover); }
      } catch (e) { console.warn(e); }
      tray.set(`正在放上书架 ${i + 1} / ${files.length}`, (i + 1) / files.length);
    }
    tray.done(added ? `放好了 ${added} 本` + (dup ? `，${dup} 本已在架上` : '') : dup ? '这些书已在架上' : '没能导入');
    this.render();
  }
  async #upload(files) {
    const big = files.filter(f => f.size > 95 * 1024 * 1024);
    const ok = files.filter(f => f.size <= 95 * 1024 * 1024);
    const tray = this.#tray(`上传到云端 0 / ${ok.length}`);
    let done = 0;
    for (const f of ok) {
      try {
        await api.upload(f, p => tray.set(`上传《${f.name.replace(/\.[^.]+$/, '').slice(0, 16)}》 ${Math.round(p * 100)}%`, (done + p) / ok.length));
        done++;
      } catch (e) { toast(`${f.name} 上传失败：${e.message}`); }
    }
    for (const f of big) { const meta = await peekMeta(f); await store.addLocal(f, meta); }
    await store.refresh();
    tray.done(`已存入云端 ${done} 本` + (big.length ? `；${big.length} 本超过 95 MB，先存在本机` : ''));
    this.render();
  }
  #tray(text) {
    const el = this.ui.tray, bar = $('i', el), label = $('span', el);
    label.textContent = text; bar.style.width = '0%'; el.classList.add('show');
    return { set: (t, f) => { label.textContent = t; bar.style.width = (f * 100).toFixed(1) + '%'; }, done: t => { label.textContent = t; bar.style.width = '100%'; setTimeout(() => el.classList.remove('show'), 2200); } };
  }
  #importMenu(anchor) {
    const up = store.authed;
    const menu = this.#menu(anchor, [
      ['file', '选择书籍文件', () => pickFiles({ accept: ACCEPT }).then(f => this.import(f))],
      ['folder', '导入整个文件夹', () => pickFiles({ directory: true }).then(f => this.import(f))],
      up ? ['cloud', localStorage.getItem('zb-upload') !== '0' ? '导入时存入云端 ✓' : '导入时存入云端', () => { localStorage.setItem('zb-upload', localStorage.getItem('zb-upload') === '0' ? '1' : '0'); toast(localStorage.getItem('zb-upload') === '0' ? '之后导入的书只存在本机' : '之后导入的书会存入云端，多端可读'); }] : null,
    ].filter(Boolean), '支持 PDF · EPUB · MOBI/AZW3 · TXT · Markdown · Word · FB2 · HTML · CBZ');
    return menu;
  }
  #menu(anchor, items, note) {
    this.ui.menu.replaceChildren(...items.map(([ic, label, fn]) => h('button', { html: icon(ic) + `<span>${esc(label)}</span>`, onclick: () => { this.#closeMenu(); fn(); } })), note ? h('p', { class: 'menu-note' }, note) : '');
    const r = anchor.getBoundingClientRect(), m = this.ui.menu;
    m.classList.add('show');
    const w = m.offsetWidth;
    m.style.left = clamp(r.right - w, 12, innerWidth - w - 12) + 'px'; m.style.top = r.bottom + 8 + 'px';
    setTimeout(() => document.addEventListener('pointerdown', this.#outside, { once: true }), 0);
  }
  #outside = e => { if (!this.ui.menu.contains(e.target)) this.#closeMenu(); else document.addEventListener('pointerdown', this.#outside, { once: true }); };
  #closeMenu() { this.ui.menu.classList.remove('show'); }

  #moreMenu(anchor) {
    const s = store.settings;
    const sorts = [['recent', '最近阅读'], ['title', '书名'], ['added', '加入时间'], ['progress', '阅读进度']];
    this.#menu(anchor, [
      ...sorts.map(([k, l]) => ['sort', (s.sort === k ? '✓ ' : '　 ') + '按' + l, () => { store.set({ sort: k }); this.#apply(true); }]),
      ['list', s.view === 'list' ? '切换为书架视图' : '切换为列表视图', () => { store.set({ view: s.view === 'list' ? 'grid' : 'list' }); this.#applyView(); }],
      store.authed ? ['logout', '断开云端书库', async () => { await api.logout(); store.authed = false; await store.refresh().catch(() => {}); location.reload(); }] : ['key', '打开云端书库…', () => this.#login()],
    ]);
  }
  #applyView() { this.root.classList.toggle('list-view', store.settings.view === 'list'); this.#apply(false); }

  #renderAccount() {
    this.ui.keyBtn.hidden = store.authed;
    this.#applyView();
  }
  #login() {
    const input = h('input', { class: 'key-input', type: 'password', placeholder: '书库钥匙', autocomplete: 'current-password', enterkeyhint: 'go', 'aria-label': '书库钥匙' });
    const msg = h('p', { class: 'key-msg' });
    const go = async () => {
      if (!input.value.trim()) return;
      try { await api.login(input.value.trim()); store.authed = true; this.closeSheet(); toast('书库已打开'); await store.refresh(); this.render(); }
      catch (e) { msg.textContent = e.message || '没能打开'; input.select(); input.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 }); }
    };
    input.addEventListener('keydown', e => e.key === 'Enter' && go());
    this.openSheet(h('div', { class: 'login' }, h('div', { class: 'login-mark', html: icon('key') }), h('h3', null, '打开云端书库'), h('p', { class: 'sub' }, '输入一次，这台设备就会记住。阅读进度、书签与划线会在各端之间同步。'), input, msg, h('button', { class: 'btn wide', onclick: go }, '打开')), 'narrow');
    setTimeout(() => input.focus(), 120);
  }
  #renderWelcome() {
    this.ui.welcome.replaceChildren(
      h('div', { class: 'welcome-mark', 'aria-hidden': 'true' }),
      h('h2', null, '书架还空着'),
      h('p', null, '空着，正好可以放下一本书。'),
      h('div', { class: 'welcome-acts' },
        h('button', { class: 'btn', html: icon('key') + '<span>打开云端书库</span>', onclick: () => this.#login() }),
        h('button', { class: 'btn ghost', html: icon('file') + '<span>导入本地书籍</span>', onclick: e => this.#importMenu(e.currentTarget) })),
      h('p', { class: 'hint' }, isTouch ? '支持 PDF、EPUB、MOBI、TXT、Word 等格式' : '也可以直接把书籍文件或整个文件夹拖进来'));
  }

  // ---------- 事件 ----------
  #wire() {
    const ui = this.ui;
    const runSearch = debounce(() => this.#apply(true), 90);
    ui.q.addEventListener('input', () => { this.q = ui.q.value.trim(); ui.search.classList.toggle('has', !!this.q); runSearch(); });
    ui.q.addEventListener('keydown', e => {
      if (e.key === 'Escape') { ui.q.value = ''; this.q = ''; ui.search.classList.remove('has'); this.#apply(true); ui.q.blur(); }
      if (e.key === 'Enter') { const first = [...this.cards.values()].find(c => c.m && !c.el.hidden && c.el.parentNode); if (first) first.el.click(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); $('.book:not([hidden])', ui.shelf)?.focus(); }
    });
    ui.search.addEventListener('focusin', () => this.root.classList.add('search-focus'));
    ui.search.addEventListener('focusout', () => setTimeout(() => { if (!ui.search.contains(document.activeElement)) this.root.classList.remove('search-focus'); }, 0));
    ui.qClear.onclick = () => { ui.q.value = ''; this.q = ''; ui.search.classList.remove('has'); this.#apply(true); ui.q.focus(); };
    ui.searchToggle.onclick = () => { this.root.classList.add('search-focus'); ui.q.focus(); };
    ui.addBtn.onclick = e => this.#importMenu(e.currentTarget);
    ui.themeBtn.onclick = () => toggleNight();
    ui.moreBtn.onclick = e => this.#moreMenu(e.currentTarget);
    ui.keyBtn.onclick = () => this.#login();
    ui.scrim.onclick = () => this.closeSheet();
    this.#sheetDrag();
    document.addEventListener('keydown', e => {
      if (this.root.hidden || document.documentElement.classList.contains('reading')) return;
      if (e.key === 'Escape' && this.root.classList.contains('sheet-open')) { this.closeSheet(); return; }
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); ui.q.focus(); ui.q.select(); }
      if (!typing && !e.metaKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) { const c = $$('.cat', ui.cats)[+e.key - 1]; c && this.setCat(c.dataset.cat); }
      if (!typing && ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key) && document.activeElement?.classList.contains('book')) { e.preventDefault(); gridNav(document.activeElement, e.key); }
    });
    // 拖入导入
    let depth = 0;
    const dz = ui.drop;
    addEventListener('dragenter', e => { if (![...e.dataTransfer.types].includes('Files') || document.documentElement.classList.contains('reading')) return; depth++; dz.classList.add('show'); });
    addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('show'); });
    addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    addEventListener('drop', async e => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault(); depth = 0; dz.classList.remove('show');
      if (document.documentElement.classList.contains('reading')) return;
      this.import(await filesFromDrop(e.dataTransfer));
    });
    addEventListener('resize', debounce(() => this.#moveInk(false), 120));
    // 列表 sheet 下拉关闭
    let y0 = null;
    ui.sheet.addEventListener('pointerdown', e => { if (e.target.classList.contains('grab')) { y0 = e.clientY; ui.sheet.setPointerCapture(e.pointerId); ui.sheet.style.transition = 'none'; } });
    ui.sheet.addEventListener('pointermove', e => { if (y0 != null) ui.sheet.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; });
    ui.sheet.addEventListener('pointerup', e => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; ui.sheet.style.transition = ''; ui.sheet.style.transform = ''; if (dy > 80) this.closeSheet(); });
    // 头部随滚动收拢
    let lastY = 0;
    addEventListener('scroll', () => { const y = scrollY; this.root.classList.toggle('scrolled', y > 8); lastY = y; }, { passive: true });
  }
}

function closeBtn(fn) { return h('button', { class: 'ib sm', 'aria-label': '关闭', html: icon('close'), onclick: fn }); }

function genCover(b) {
  const t = b.title || '无题';
  const cjk = /[一-鿿]/.test(t);
  const short = t.replace(/[（(].*?[)）]/g, '').split(/[：:·—]/)[0].trim() || t;
  const vertical = cjk && short.length <= 9;
  return [h('div', { class: 'gen-frame' },
    h('div', { class: 'gen-title' + (vertical ? ' v' : '') + (short.length > 14 ? ' long' : '') }, vertical ? short : t),
    b.author ? h('div', { class: 'gen-author' }, b.author.split(/[·、,，]/)[0].trim()) : null,
    h('i', { class: 'gen-seal' }))];
}

function tilt(el) {
  let raf;
  el.addEventListener('pointermove', e => {
    const c = el.querySelector('.cover-wrap'); if (!c) return;
    const r = c.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { c.style.setProperty('--rx', (-y * 7).toFixed(2) + 'deg'); c.style.setProperty('--ry', (x * 9).toFixed(2) + 'deg'); c.style.setProperty('--gx', (x * 100 + 50).toFixed(1) + '%'); c.style.setProperty('--gy', (y * 100 + 50).toFixed(1) + '%'); });
  });
  el.addEventListener('pointerleave', () => { const c = el.querySelector('.cover-wrap'); c?.style.removeProperty('--rx'); c?.style.removeProperty('--ry'); });
}

function gridNav(el, key) {
  const all = [...el.parentNode.querySelectorAll('.book:not([hidden])')];
  const i = all.indexOf(el), r = el.getBoundingClientRect();
  let target;
  if (key === 'ArrowRight') target = all[i + 1];
  else if (key === 'ArrowLeft') target = all[i - 1];
  else {
    const dir = key === 'ArrowDown' ? 1 : -1;
    const cands = all.filter(x => { const q = x.getBoundingClientRect(); return dir > 0 ? q.top > r.bottom - 4 : q.bottom < r.top + 4; });
    target = cands.sort((a, b) => { const qa = a.getBoundingClientRect(), qb = b.getBoundingClientRect(); return Math.abs(qa.top - r.top) - Math.abs(qb.top - r.top) || Math.abs(qa.left - r.left) - Math.abs(qb.left - r.left); })[0];
    if (!target && dir < 0) { document.querySelector('.lib-search input')?.focus(); return; }
  }
  target?.focus();
  target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function filesFromDrop(dt) {
  const out = [];
  const walk = async entry => {
    if (!entry) return;
    if (entry.isFile) out.push(await new Promise(r => entry.file(r, () => r(null))));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { const batch = await new Promise(r => reader.readEntries(r, () => r([]))); if (!batch.length) break; for (const e of batch) await walk(e); }
    }
  };
  const items = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (items.length) for (const e of items) await walk(e); else out.push(...dt.files);
  return out.filter(Boolean);
}

const TEMPLATE = `
<header class="lib-head">
  <div class="brand"><span class="seal" aria-label="知白">知<br>白</span><div class="brand-txt"><b>知白</b><span data-ref="greet"></span></div></div>
  <div class="lib-search" data-ref="search">
    ${icon('search')}
    <input data-ref="q" type="search" placeholder="书名、作者，或拼音首字母" autocomplete="off" enterkeyhint="search" aria-label="搜索书籍">
    <span class="count" data-ref="count"></span>
    <button class="ib sm q-clear" data-ref="qClear" aria-label="清除">${icon('close')}</button>
    <kbd>/</kbd>
  </div>
  <div class="lib-actions">
    <button class="ib mobile-only" data-ref="searchToggle" aria-label="搜索">${icon('search')}</button>
    <button class="ib" data-ref="keyBtn" aria-label="打开云端书库" title="打开云端书库">${icon('key')}</button>
    <button class="ib" data-ref="addBtn" aria-label="导入书籍" title="导入书籍">${icon('plus')}</button>
    <button class="ib" data-ref="themeBtn" aria-label="日夜切换" title="日夜切换 (D)"><span class="sun">${icon('sun')}</span><span class="moon">${icon('moon')}</span></button>
    <button class="ib" data-ref="moreBtn" aria-label="更多" title="排序与视图">${icon('more')}</button>
  </div>
</header>
<main class="lib-main">
  <section class="hero" data-ref="hero" hidden></section>
  <nav class="cats" data-ref="cats" role="tablist" aria-label="分类"></nav>
  <section class="shelf" data-ref="shelf" aria-live="polite"></section>
  <div class="none" data-ref="none" hidden></div>
  <section class="welcome" data-ref="welcome" hidden></section>
  <footer class="lib-foot" data-ref="foot"></footer>
</main>
<div class="lib-scrim" data-ref="scrim"></div>
<section class="lib-sheet" data-ref="sheet" tabindex="-1"></section>
<div class="menu" data-ref="menu" role="menu"></div>
<div class="tray" data-ref="tray"><span></span><b><i></i></b></div>
<div class="drop" data-ref="drop"><div><div class="drop-ring"></div><p>松手，放上书架</p></div></div>`;
