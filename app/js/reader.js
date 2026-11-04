// 阅读器外壳：沉浸式页面、隐现的工具栏、目录/书签/笔记、排版、书内搜索、划线、脚注、进度与多端续读
import { h, $, $$, icon, clamp, debounce, toast, fmtDuration, pct, relTime, isTouch, uid, esc, sleep } from './util.js';
import { store, api } from './store.js';
import { Pager } from './pager.js';
import { FlowDoc, FlowScroll } from './flow.js';
import { PdfDoc, PdfScroll } from './pdfdoc.js';
import { openFlowBook } from './formats.js';
import { pdfToBook } from './reflow.js';
import { selectionQuads, mergeImported, exportPdf, tidy } from './annot.js';
import { applyTheme, effectiveTheme, THEMES } from './theme.js';

const TURNS = [['curl', '仿真'], ['cover', '覆盖'], ['slide', '平移'], ['fade', '淡入'], ['scroll', '滚动']];
const COLORS = [['y', '缃'], ['g', '青'], ['b', '黛'], ['r', '绛']];

export class Reader {
  constructor(root) {
    this.root = root;
    root.innerHTML = TEMPLATE;
    this.stage = $('.r-stage', root);
    this.ui = Object.fromEntries($$('[data-ref]', root).map(e => [e.dataset.ref, e]));
    this.#wire();
  }

  // ================= 打开 / 关闭 =================
  async open(book, { onFirstPaint, pdf } = {}) {
    const token = this.token = uid();
    this.book = book;
    this.root.hidden = false;
    this.root.classList.remove('chrome', 'ended');
    this.root.classList.add('loading');
    this.ui.title.textContent = book.title;
    this.ui.sub.textContent = book.author || '';
    this.ui.loadMsg.textContent = '';
    this.#closeSheets();
    document.documentElement.classList.add('reading');
    applyTheme(store.settings);
    this.#applyType();
    try {
      const doc = await this.#load(book, token, pdf);
      if (token !== this.token) { doc.destroy?.(); return; }
      this.doc = doc;
      this.root.dataset.kind = doc.kind;
      this.notes = store.state(book.id).notes?.items || [];
      doc.setNotes(this.notes);
      this.toc = doc.kind === 'pdf' ? await doc.toc() : doc.book.toc;
      let saved = store.state(book.id).progress?.pos;
      if (doc.book?.reflow && saved && saved.s == null && saved.page != null) saved = await doc.book.anchorOfPage(doc, saved.page);
      await this.#mountView(saved);
      if (token !== this.token) return;
      this.root.classList.remove('loading');
      onFirstPaint?.();
      this.#startSession();
      this.#scanAnnots();
      if (doc.kind === 'pdf' && cropOn()) doc.computeCrop().then(() => { if (this.doc === doc && doc.crop && store.settings.turn !== 'scroll') this.#mountView(this.anchor); });
      if (doc.kind === 'flow') setTimeout(() => doc.ensureSizes().then(() => this.#updateUI()), 1500);
      this.#hint();
    } catch (e) {
      console.error(e);
      if (token !== this.token) return;
      this.ui.loadMsg.textContent = '这本书没能打开：' + (e.message || e);
      this.root.classList.add('failed');
      onFirstPaint?.();
      throw e;
    }
  }

  async #load(book, token, reuse) {
    const fmt = book.format;
    const progress = (f, what = '取书') => { if (token === this.token) this.ui.loadMsg.textContent = f > .02 && f < 1 ? `正在${what} ${Math.round(f * 100)}%` : ''; };
    if (fmt === 'pdf') {
      let pdf = reuse;
      if (!pdf && book.local) { const blob = await store.localFile(book.id); if (blob) pdf = await PdfDoc.open({ data: new Uint8Array(await blob.arrayBuffer()) }); }
      if (!pdf) pdf = await PdfDoc.open({ url: api.fileUrl(book.id) }, { onProgress: progress });
      if (!store.pref(book.id).reflow) return pdf;
      const fb = await pdfToBook(pdf, book, f => progress(f, '重排'));
      if (fb.sections.reduce((a, x) => a + x.size, 0) < pdf.n * 20) { // 几乎没有文字：其实是扫描版
        store.setPref(book.id, { reflow: false }); toast('这份 PDF 是扫描图像，已回到原版'); return pdf;
      }
      return new FlowDoc(fb, this.stage);
    }
    let blob = book.local ? await store.localFile(book.id) : null;
    if (!blob) blob = await fetchWithProgress(api.fileUrl(book.id), progress);
    const fb = await openFlowBook(blob, { name: book.name || book.path || ('book.' + fmt), format: fmt, title: book.title, author: book.author });
    if (!book.cover && !book.localCover) fb.getCover?.().then(c => c && store.saveCover(book.id, c).then(() => store.emit('books')));
    return new FlowDoc(fb, this.stage);
  }

  async #mountView(anchor) {
    const old = this.view;
    try { await this.#mountNew(anchor); } finally { if (old && old !== this.view) old.destroy(); }
  }
  async #mountNew(anchor) {
    const s = store.settings, doc = this.doc;
    const scroll = s.turn === 'scroll';
    this.root.classList.toggle('scrolling', scroll);
    const onTap = (zone, e) => this.#onTap(zone, e);
    if (doc.kind === 'pdf') {
      const page = anchor?.page ?? 0;
      if (scroll) {
        this.view = new PdfScroll(doc, this.stage, { onChange: (p, frac) => this.#onPos({ page: p, frac }), onTap, onZoom: z => this.#onZoom(z) });
        await this.view.open(page, anchor?.frac || 0);
      } else {
        this.#layoutDoc();
        this.view = new Pager(this.stage, doc, { effect: s.turn, onChange: pos => this.#onPos({ page: doc.pageOf(pos) }, pos), onTap, onEdge: d => this.#onEdge(d) });
        await this.view.open(doc.posOf(page));
      }
    } else {
      const a = anchor && anchor.s != null ? anchor : { s: 0, o: 0 };
      if (scroll) {
        this.view = new FlowScroll(doc, this.stage, { onChange: a => this.#onPos(a), onTap, onLink: (l, e) => this.#onLink(l, e) });
        this.#layoutDoc();
        await this.view.open(a);
      } else {
        this.#layoutDoc();
        this.view = new Pager(this.stage, doc, { effect: s.turn, onChange: async pos => this.#onPos(await doc.anchorOf(pos), pos), onTap, onEdge: d => this.#onEdge(d), onLink: (l, e) => this.#onLink(l, e) });
        await this.view.open(await doc.posOf(a));
      }
    }
    this.root.classList.toggle('spread', !!this.doc?.L?.spread && !scroll);
  }

  #onZoom(z) {
    this.ui.zoomVal.textContent = Math.round(z * 100) + '%';
    this.root.classList.add('zooming'); clearTimeout(this.zoomT);
    this.zoomT = setTimeout(() => this.root.classList.remove('zooming'), 1600);
  }
  #insets() {
    const cs = getComputedStyle(this.ui.probe);
    return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  }
  #layoutDoc() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    this.lastSize = W + 'x' + H;
    this.doc.setLayout(W, H, store.settings, this.#insets());
  }

  async close() {
    this.token = null;
    this.#endSession();
    this.#saveNow();
    this.#closeSheets(); this.#hideSel(); this.ui.notePop.classList.remove('show'); this.#closeEditor(null);
    this.annScan?.abort();
    this.view?.destroy(); this.view = null;
    this.doc?.destroy?.(); this.doc = null;
    this.root.hidden = true;
    this.root.classList.remove('chrome', 'loading', 'failed', 'ended', 'spread', 'scrolling');
    document.documentElement.classList.remove('reading');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    applyTheme(store.settings);
  }

  // ================= 位置 =================
  #onPos(anchor, pos) {
    if (!this.doc) return;
    if (this.doc.book?.reflow && anchor?.s != null) anchor = { ...anchor, page: this.doc.book.pageAt(this.doc, anchor) };
    this.anchor = anchor; this.pos = pos;
    this.lastActive = Date.now();
    this.#updateUI();
    this.#save();
    if (this.doc.kind === 'pdf' && this.view instanceof Pager) for (const f of this.view.cur?.faces || []) this.doc.textLayer(f);
  }
  #progress() {
    const a = this.anchor; if (!a) return 0;
    if (this.doc.kind === 'pdf') return this.doc.n <= 1 ? 1 : clamp((a.page + (a.frac || 0)) / (this.doc.n - 1), 0, 1);
    return this.doc.progressOf(a);
  }
  #label() {
    const a = this.anchor; if (!a) return '';
    if (this.doc.kind === 'pdf') {
      const pages = this.view instanceof Pager ? this.doc.pagesOf(this.view.pos).filter(p => p >= 0 && p < this.doc.n) : [a.page];
      return `第 ${pages.map(p => p + 1).join('–')} 页`;
    }
    return this.doc.sectionTitle(a.s);
  }
  #save = debounce(() => this.#saveNow(), 700);
  #saveNow() {
    if (!this.book || !this.anchor || !this.doc) return;
    const p = this.#progress();
    store.setProgress(this.book.id, { pos: this.anchor, pct: p, label: this.#label(), total: this.doc.kind === 'pdf' ? this.doc.n : undefined });
  }
  #updateUI() {
    if (!this.anchor || !this.doc) return;
    const p = this.#progress();
    if (!this.scrubbing) this.ui.range.value = Math.round(p * 1000);
    this.ui.range.style.setProperty('--v', p);
    const label = this.#label();
    this.ui.sub.textContent = this.doc.kind === 'pdf' ? `${label} · 共 ${this.doc.n} 页` : this.doc.book.reflow && this.anchor.page != null ? `${label} · 原书第 ${this.anchor.page + 1} 页` : label;
    this.ui.hudL.textContent = this.doc.kind === 'pdf' ? '' : (this.view instanceof Pager ? '' : label);
    this.ui.hudR.textContent = this.doc.kind === 'pdf' ? `${(this.anchor.page ?? 0) + 1} / ${this.doc.n}` : pct(p);
    this.#updateMark();
    if (this.sheet === 'toc') this.#markCurrentToc();
  }

  async go(anchor, { remember = true } = {}) {
    if (!this.view || !anchor) return;
    if (remember && this.anchor) this.#offerReturn(this.anchor);
    if (this.doc.book?.reflow && anchor.s == null && anchor.page != null) anchor = await this.doc.book.anchorOfPage(this.doc, anchor.page);
    if (this.doc.kind === 'pdf') {
      if (anchor.page == null) return;
      if (this.view instanceof Pager) await this.view.go(this.doc.posOf(anchor.page));
      else await this.view.go(anchor.page);
    } else if (this.view instanceof Pager) await this.view.go(await this.doc.posOf(anchor));
    else await this.view.go(anchor);
  }
  turn(dir) { this.#hideSel(); return this.view?.turn(dir); }

  #offerReturn(from) {
    const pill = this.ui.ret;
    this.returnTo = from;
    const label = this.doc.kind === 'pdf' ? `第 ${from.page + 1} 页` : this.doc.sectionTitle(from.s);
    pill.innerHTML = `${icon('undo')}<span>回到 ${esc(label.slice(0, 18))}</span>`;
    pill.classList.add('show');
    clearTimeout(this.retT); this.retT = setTimeout(() => pill.classList.remove('show'), 7000);
  }

  // ================= 交互 =================
  #onTap(zone, e) {
    const mark = e?.target?.closest?.('mark.hl');
    if (mark && !this.root.classList.contains('chrome')) { const n = this.notes.find(x => x.id === mark.dataset.id); if (n) { this.#showNoteFor(n, mark.getBoundingClientRect()); return; } }
    const ann = e && this.doc?.kind === 'pdf' && !this.root.classList.contains('chrome') ? document.elementsFromPoint(e.clientX, e.clientY).find(el => el.matches?.('.ann-q, .ann-pin, .ann-box')) : null;
    if (ann) { const n = this.notes.find(x => x.id === ann.dataset.id); if (n) { this.#showNoteFor(n, ann.getBoundingClientRect()); return; } }
    if (this.ui.notePop.classList.contains('show')) { this.ui.notePop.classList.remove('show'); return; }
    if (this.sheet) { this.#closeSheets(); return; }
    if (this.root.classList.contains('chrome')) { this.#chrome(false); return; }
    if (this.view instanceof Pager && zone) { this.turn(zone); return; }
    if (!(this.view instanceof Pager) && zone && this.doc?.kind === 'flow') { this.turn(zone); return; }
    this.#chrome(true);
  }
  #chrome(on) {
    this.root.classList.toggle('chrome', on);
    if (on) { this.#updateUI(); this.ui.range.focus({ preventScroll: true }); this.ui.range.blur(); }
  }
  #onEdge(dir) {
    if (dir < 0) { toast('已是第一页'); return; }
    this.#saveNow();
    this.#showEnd();
  }
  #showEnd() {
    const id = this.book.id;
    const total = store.readingTime(id);
    const days = new Set(Object.values(store.state(id).stats || {}).flatMap(d => Object.keys(d))).size;
    this.ui.endStats.textContent = total > 60 ? `前后读了 ${fmtDuration(total)}${days > 1 ? `，跨越 ${days} 天` : ''}。` : '';
    this.root.classList.add('ended');
    store.setProgress(id, { ...store.state(id).progress, pct: 1, finished: true });
  }

  async #onLink(a, e) {
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) { if (confirm('在新标签页打开外部链接？\n' + href)) window.open(href, '_blank', 'noopener'); return; }
    if (this.doc.kind !== 'flow') return;
    const from = +(a.closest('.flow-content')?.dataset.s ?? this.anchor?.s ?? 0);
    const r = await this.doc.book.resolveLink(href, from);
    if (!r) return;
    let target = r;
    if (r.selector && r.offset == null) {
      const t = await this.doc.tpl(r.s); const el = t.el.querySelector(r.selector);
      target = { s: r.s, offset: el ? this.doc.offsetIn(t.el, el, 0) : 0, text: el?.closest('p,li,aside,div')?.textContent?.trim() };
    }
    const isNote = a.matches('[epub\\:type~="noteref"],[role="doc-noteref"]') || /^[\[\(（]?\s*[\d①-⑳*†‡]+\s*[\]\)）]?$/.test(a.textContent.trim());
    if (isNote && target.text && target.text.length < 900) { this.#notePop(a, target.text, () => this.go({ s: target.s, o: target.offset })); return; }
    this.go({ s: target.s, o: target.offset || 0 });
  }
  #notePop(anchorEl, text, onJump) {
    const pop = this.ui.notePop;
    pop.replaceChildren(h('div', { class: 'np-text' }, text), onJump ? h('button', { class: 'np-jump', onclick: () => { pop.classList.remove('show'); onJump(); } }, '跳到原处') : null);
    this.#placePop(pop, anchorEl.getBoundingClientRect());
    pop.classList.add('show');
  }
  #placePop(pop, rc) {
    const W = innerWidth, H = innerHeight;
    pop.style.visibility = 'hidden'; pop.classList.add('show');
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.classList.remove('show'); pop.style.visibility = '';
    let x = clamp(rc.left + rc.width / 2 - pw / 2, 12, W - pw - 12);
    let y = rc.top - ph - 12; let below = false;
    if (y < 12) { y = rc.bottom + 12; below = true; }
    if (y + ph > H - 12) y = H - ph - 12;
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
    pop.classList.toggle('below', below);
    pop.style.setProperty('--ax', clamp(rc.left + rc.width / 2 - x, 16, pw - 16) + 'px');
  }

  // ================= 划线与笔记 =================
  #onSelection = debounce(() => {
    if (!this.doc || this.root.hidden || this.editing) return;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { this.#hideSel(); return; }
    const range = sel.getRangeAt(0);
    if (this.doc.kind === 'pdf') { this.#onPdfSelection(sel, range); return; }
    const root = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer)?.closest?.('.flow-content');
    if (!root || !this.stage.contains(root)) return;
    const endRoot = (range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer)?.closest?.('.flow-content');
    const s = +root.dataset.s;
    const a = this.doc.offsetIn(root, range.startContainer, range.startOffset);
    let b = endRoot && +endRoot.dataset.s === s ? this.doc.offsetIn(endRoot, range.endContainer, range.endOffset) : a + sel.toString().length;
    if (b <= a) return;
    this.sel = { s, a, b, text: sel.toString().trim().slice(0, 2000) };
    this.#showSelPop(range);
  }, 260);
  // PDF：选区落在某页文字层上，换算成该页的高亮四边形
  #onPdfSelection(sel, range) {
    const node = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const layer = node?.closest?.('.textLayer'), wrap = layer?.closest('.pdf-page');
    if (!wrap || !this.stage.contains(wrap)) return;
    const page = +wrap.dataset.page, vp1 = this.doc.vp1(page);
    const quads = vp1 ? selectionQuads(range, layer, vp1) : [];
    if (!quads.length) return;
    this.sel = { pdf: true, page, quads, text: tidy(sel.toString()).slice(0, 2000) };
    this.#showSelPop(range);
  }
  #showSelPop(range) {
    const pop = this.ui.selPop;
    pop.replaceChildren(
      ...COLORS.map(([c, name]) => h('button', { class: 'sw c-' + c, title: name, 'aria-label': '划线：' + name, onclick: () => this.#addNote(c) })),
      h('span', { class: 'sep' }),
      h('button', { class: 'pb', html: icon('note') + '<span>笔记</span>', onclick: () => this.#addNote('y', true) }),
      h('button', { class: 'pb', html: icon('copy') + '<span>复制</span>', onclick: () => { navigator.clipboard?.writeText(this.sel.text); toast('已复制'); this.#hideSel(true); } }),
      h('button', { class: 'pb', html: icon('search') + '<span>搜索</span>', onclick: () => { const q = this.sel.text.slice(0, 30); this.#hideSel(true); this.#openSearch(q); } }),
    );
    const rects = range.getClientRects(); const rc = rects[0] || range.getBoundingClientRect();
    this.#placePop(pop, rc);
    pop.classList.add('show');
  }
  #hideSel(clear) { this.ui.selPop.classList.remove('show'); if (clear) getSelection()?.removeAllRanges(); }
  async #addNote(color, withNote) {
    const sl = this.sel; if (!sl) return;
    let n;
    if (sl.pdf) n = { id: uid(), kind: 'pdf', type: 'Highlight', page: sl.page, quads: sl.quads, color, text: sl.text, note: '', label: `第 ${sl.page + 1} 页`, t: Date.now() };
    else {
      n = { id: uid(), s: sl.s, a: sl.a, b: sl.b, color, text: sl.text, note: '', label: this.doc.sectionTitle(sl.s), t: Date.now() };
      if (this.doc.book?.reflow) n.page = this.doc.book.pageAt(this.doc, { s: sl.s, o: sl.a });
    }
    this.#hideSel(true);
    if (withNote) {
      const r = await this.#editNote(n, { fresh: true });
      if (!r) return;
      Object.assign(n, r);
    }
    const overlaps = x => !x.del && (sl.pdf ? x.kind === 'pdf' && !x.aid && x.page === n.page && overlapQuads(x.quads, n.quads) : x.s === n.s && x.a < n.b && x.b > n.a);
    this.notes = [...this.notes.filter(x => !overlaps(x)), n];
    this.#persistNotes();
  }
  #updateNote(n, patch) {
    if (patch.color && patch.color !== n.color) patch.recolored = true;
    Object.assign(n, patch, { t: Date.now() });
    if (n.aid) n.edited = true;
    this.#persistNotes();
  }
  #removeNote(n) {
    // 文件自带的批注留一条「已删」记录：下载 PDF 时才能把它从文件里拿掉，重新扫描也不会回来
    this.notes = n.aid ? this.notes.map(x => x === n ? { ...x, del: true, t: Date.now() } : x) : this.notes.filter(x => x !== n);
    this.#persistNotes();
  }
  #persistNotes() {
    store.setNotes(this.book.id, this.notes);
    if (this.doc.kind === 'pdf') this.doc.setNotes(this.notes, this.stage);
    else { this.doc.setNotes(this.notes); if (this.view instanceof Pager) this.view.relayout(); else this.view?.refreshNotes?.(); }
    if (this.sheet === 'toc') this.#renderTocPanel();
  }
  #showNoteFor(n, rc) {
    const pop = this.ui.selPop;
    const drawing = n.kind === 'pdf' && !n.quads && n.type !== 'Text' && n.type !== 'FreeText';
    pop.replaceChildren(
      ...(drawing ? [] : COLORS.map(([c, name]) => h('button', { class: 'sw c-' + c + (n.color === c ? ' on' : ''), title: name, onclick: () => { this.#updateNote(n, { color: c }); pop.classList.remove('show'); } }))),
      drawing ? null : h('span', { class: 'sep' }),
      h('button', { class: 'pb', html: icon('note') + `<span>${n.note ? '改笔记' : '写笔记'}</span>`, onclick: async () => { pop.classList.remove('show'); const r = await this.#editNote(n); if (r) this.#updateNote(n, r); } }),
      h('button', { class: 'pb', html: icon('copy') + '<span>复制</span>', onclick: () => { navigator.clipboard?.writeText([n.text, n.note].filter(Boolean).join('\n\n')); toast('已复制'); pop.classList.remove('show'); } }),
      h('button', { class: 'pb', html: icon('trash') + '<span>删除</span>', onclick: () => { this.#removeNote(n); pop.classList.remove('show'); } }),
    );
    if (n.note) pop.prepend(h('div', { class: 'pop-note' }, n.by ? h('b', null, n.by + '：') : null, n.note));
    this.#placePop(pop, rc);
    pop.classList.add('show');
  }

  // ---------- 笔记编辑器 ----------
  #editNote(n, { fresh = false } = {}) {
    this.#closeEditor(null);
    const ed = this.ui.editor;
    let color = n.color || 'y';
    const input = h('textarea', { class: 'ne-input', rows: 4, placeholder: '此刻的想法……', 'aria-label': '笔记内容', maxlength: 8000 });
    input.value = n.note || '';
    const count = h('span', { class: 'ne-count' });
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, innerHeight * .46) + 'px'; const k = input.value.trim().length; count.textContent = k ? `${k} 字` : ''; };
    input.addEventListener('input', grow);
    const quote = n.text ? h('blockquote', { class: 'ne-quote c-' + color, title: '展开 / 收起', onclick: () => quote.classList.toggle('open') }, n.text) : null;
    const chips = h('div', { class: 'ne-colors', role: 'radiogroup', 'aria-label': '颜色' }, COLORS.map(([c, name]) =>
      h('button', { class: 'ne-chip c-' + c + (c === color ? ' on' : ''), role: 'radio', 'aria-checked': c === color, onclick: () => {
        color = c;
        for (const b of chips.children) { const on = b.classList.contains('c-' + c); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
        if (quote) { const open = quote.classList.contains('open'); quote.className = 'ne-quote c-' + c + (open ? ' open' : ''); }
        input.focus({ preventScroll: true });
      } }, h('i'), h('span', null, name))));
    const save = () => this.#closeEditor({ note: input.value.trim(), color });
    const del = fresh ? null : h('button', { class: 'btn ghost danger', html: icon('trash') + '<span>删除</span>', onclick: () => { this.#closeEditor(null); this.#removeNote(n); } });
    const where = [n.label, n.by ? '批注人 ' + n.by : '', !fresh && n.t ? relTime(n.t) : ''].filter(Boolean).join(' · ');
    const mac = /Mac|iP/.test(navigator.platform);
    ed.replaceChildren(
      h('div', { class: 'ne-head' }, h('div', null, h('b', null, n.note ? '修改笔记' : '写笔记'), where ? h('span', null, where) : null), h('button', { class: 'ib sm', 'aria-label': '关闭', html: icon('close'), onclick: () => this.#closeEditor(null) })),
      quote, chips,
      h('div', { class: 'ne-field' }, input),
      h('div', { class: 'ne-foot' }, del, h('span', { class: 'ne-meta' }, count, h('span', { class: 'ne-hint' }, `${mac ? '⌘' : 'Ctrl'} + Enter 保存`)),
        h('button', { class: 'btn ghost', onclick: () => this.#closeEditor(null) }, '取消'), h('button', { class: 'btn', onclick: save }, '保存')),
    );
    ed.onkeydown = e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.#closeEditor(null); }
    };
    this.editing = true;
    this.root.classList.add('editing');
    requestAnimationFrame(() => { ed.classList.add('show'); grow(); quote?.classList.toggle('long', quote.scrollHeight > quote.clientHeight + 4); input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); });
    return new Promise(r => { this.editDone = r; });
  }
  #closeEditor(result) {
    if (!this.editing) return;
    this.editing = false;
    this.ui.editor.classList.remove('show'); this.root.classList.remove('editing');
    const r = this.editDone; this.editDone = null; r?.(result);
  }

  // ---------- 文件自带的批注 ----------
  async #scanAnnots() {
    const pdf = this.doc?.kind === 'pdf' ? this.doc : this.doc?.book?.pdf;
    if (!pdf?.scanAnnots || store.pref(this.book.id).annScan === 1) return;
    const id = this.book.id, ac = this.annScan = new AbortController();
    let found = 0;
    await pdf.scanAnnots(list => {
      if (ac.signal.aborted || this.book?.id !== id) return;
      const merged = mergeImported(this.notes, list); if (!merged) return;
      found += merged.length - this.notes.length;
      this.notes = merged; this.#persistNotes();
    }, ac.signal).catch(e => console.warn(e));
    if (ac.signal.aborted || this.book?.id !== id) return;
    store.setPref(id, { annScan: 1 });
    if (found) toast(`已载入这份 PDF 自带的 ${found} 条批注`);
  }
  async #downloadPdf() {
    const pdf = this.doc?.kind === 'pdf' ? this.doc : this.doc?.book?.pdf;
    if (!pdf || this.exporting) return;
    this.exporting = true;
    toast('正在把笔记写进 PDF…', { duration: 120000 });
    try {
      const bytes = await pdf.pdf.getData();
      const { blob, added, changed, removed } = await exportPdf(bytes, this.notes.filter(n => n.kind === 'pdf'));
      const a = h('a', { href: URL.createObjectURL(blob), download: `${this.book.title}（含笔记）.pdf` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      toast('已下载：' + ([added && `新增 ${added} 条`, changed && `修改 ${changed} 条`, removed && `删去 ${removed} 条`].filter(Boolean).join('，') || '笔记与原文件一致'));
    } catch (e) { console.error(e); toast('写入失败：' + (e.message || e)); }
    finally { this.exporting = false; }
  }

  // ================= 书签 =================
  #marks() { return store.state(this.book.id).marks?.items || []; }
  #isMarkedHere() {
    const a = this.anchor; if (!a) return null;
    if (this.doc.kind === 'pdf') {
      const pages = this.view instanceof Pager ? this.doc.pagesOf(this.view.pos) : [a.page];
      return this.#marks().find(m => pages.includes(m.pos.page));
    }
    if (this.view instanceof Pager && this.pos) {
      const t = this.doc.tpls.get(this.pos.s);
      if (!t?.pages) return null;
      const inc = this.doc.L.spread ? 2 : 1;
      const lo = this.doc.offsetOfPage(t, this.pos.p), hi = this.pos.p + inc >= t.pages ? Infinity : this.doc.offsetOfPage(t, this.pos.p + inc);
      return this.#marks().find(m => m.pos.s === a.s && m.pos.o >= lo && m.pos.o < hi);
    }
    return this.#marks().find(m => m.pos.s === a.s && Math.abs(m.pos.o - a.o) < 200);
  }
  #updateMark() {
    const m = !!this.#isMarkedHere();
    this.root.classList.toggle('marked', m);
    this.ui.markBtn.innerHTML = icon(m ? 'bookmarkFill' : 'bookmark');
  }
  async toggleMark() {
    if (!this.anchor) return;
    const existing = this.#isMarkedHere();
    let items = this.#marks();
    if (existing) { items = items.filter(m => m !== existing); toast('书签已移除'); }
    else {
      let snippet = '';
      if (this.doc.kind === 'flow') { const t = await this.doc.tpl(this.anchor.s); snippet = textAt(t, this.anchor.o, 60); }
      items = [...items, { id: uid(), pos: this.anchor, pct: this.#progress(), label: this.#label(), text: snippet, t: Date.now() }];
      this.root.classList.add('mark-drop'); setTimeout(() => this.root.classList.remove('mark-drop'), 600);
    }
    store.setMarks(this.book.id, items);
    this.#updateMark();
    if (this.sheet === 'toc') this.#renderTocPanel();
  }

  // ================= 面板 =================
  #openSheet(name) {
    if (this.sheet === name) { this.#closeSheets(); return; }
    this.#closeSheets(true);
    this.sheet = name;
    this.root.classList.add('sheet-open');
    const el = this.ui[name + 'Sheet'];
    if (name === 'toc') this.#renderTocPanel();
    if (name === 'type') this.#renderTypePanel();
    el.classList.add('open');
    if (name === 'search') setTimeout(() => this.ui.q.focus(), 60);
  }
  #closeSheets(keepChrome) {
    for (const k of ['toc', 'type', 'search']) this.ui[k + 'Sheet']?.classList.remove('open');
    this.sheet = null; this.root.classList.remove('sheet-open');
    if (!keepChrome && this.root.classList.contains('chrome') && isTouch) {}
  }

  #tab = 'toc';
  #renderTocPanel() {
    const body = this.ui.tocBody;
    $$('.tabs button', this.ui.tocSheet).forEach(b => b.classList.toggle('on', b.dataset.tab === this.#tab));
    this.ui.tocHead.textContent = this.book.title;
    this.ui.tocMeta.textContent = [this.book.author, this.doc?.kind === 'pdf' ? `${this.doc.n} 页` : '', `已读 ${pct(this.#progress())}`].filter(Boolean).join(' · ');
    if (this.#tab === 'toc') {
      if (!this.toc?.length) {
        body.replaceChildren(h('div', { class: 'empty-note' }, this.doc?.kind === 'pdf' ? '这份 PDF 没有自带目录。拖动下方进度条，或用缩略图定位。' : '这本书没有目录。'));
        if (this.doc?.kind === 'pdf') body.append(this.#thumbGrid());
        return;
      }
      const list = h('ol', { class: 'toc-list' });
      this.toc.forEach((e, i) => list.append(h('li', { class: 'lv' + e.level, dataset: { i } },
        h('button', { onclick: () => this.#gotoToc(e) }, h('span', { class: 'tl' }, e.label), e.page != null ? h('span', { class: 'tp' }, e.page + 1) : null))));
      body.replaceChildren(list);
      this.#markCurrentToc(true);
    } else if (this.#tab === 'marks') {
      const marks = [...this.#marks()].sort((a, b) => a.pct - b.pct);
      body.replaceChildren(marks.length ? h('ul', { class: 'mark-list' }, marks.map(m => h('li', null,
        h('button', { class: 'mk', onclick: () => { this.#closeSheets(); this.go(m.pos); } },
          h('span', { class: 'mk-l' }, m.label || ''), m.text ? h('span', { class: 'mk-t' }, m.text) : null, h('span', { class: 'mk-m' }, `${pct(m.pct)} · ${relTime(m.t)}`)),
        h('button', { class: 'ib sm', 'aria-label': '删除书签', html: icon('close'), onclick: () => { store.setMarks(this.book.id, this.#marks().filter(x => x.id !== m.id)); this.#renderTocPanel(); this.#updateMark(); } })))) : h('div', { class: 'empty-note' }, '还没有书签。读到想回来的地方，点右上角的书签即可。'));
    } else {
      const notes = this.#sortedNotes();
      const pdfNotes = this.book.format === 'pdf' && this.notes.some(n => n.kind === 'pdf');
      const acts = notes.length || pdfNotes ? h('div', { class: 'note-acts' },
        notes.length ? h('button', { class: 'link-btn', html: icon('file') + '<span>导出 Markdown</span>', onclick: () => this.#exportNotes() }) : null,
        pdfNotes ? h('button', { class: 'link-btn', html: icon('upload') + '<span>下载含笔记的 PDF</span>', onclick: () => this.#downloadPdf() }) : null) : null;
      const target = n => n.kind === 'pdf' || this.doc.kind === 'pdf' ? (n.page != null ? { page: n.page } : null) : n.s != null ? { s: n.s, o: n.a } : n.page != null ? { page: n.page } : null;
      body.replaceChildren(notes.length ? h('ul', { class: 'note-list' }, notes.map(n => h('li', { class: 'c-' + (n.color || 'y') + (n.src === 'pdf' ? ' from-pdf' : '') },
        h('button', { class: 'nl-go', disabled: !target(n), onclick: () => { this.#closeSheets(); this.go(target(n)); } },
          n.text ? h('blockquote', null, n.text) : null, n.note ? h('p', null, n.note) : null,
          h('span', { class: 'mk-m' }, [n.label, n.by, n.src === 'pdf' && !n.edited ? '来自文件' : '', n.t ? relTime(n.t) : ''].filter(Boolean).join(' · '))),
        h('button', { class: 'ib sm nl-edit', 'aria-label': '编辑笔记', title: '编辑', html: icon('edit'), onclick: async () => { const r = await this.#editNote(n); if (r) this.#updateNote(n, r); } })))) :
        h('div', { class: 'empty-note' }, this.doc?.kind === 'pdf' ? (this.doc.textualKnown === false ? '这是扫描版 PDF，没有可选中的文字，暂时无法划线。' : '在页面上选中文字即可划线、写笔记；可下载为带批注的 PDF。') : '选中文字即可划线、写笔记。'), acts);
    }
  }
  #markCurrentToc(scroll) {
    if (!this.toc?.length || this.#tab !== 'toc') return;
    let i = -1;
    if (this.doc.kind === 'pdf') { const p = this.anchor?.page ?? 0; this.toc.forEach((e, k) => { if (e.page <= p) i = k; }); }
    else i = this.doc.tocIndexOf(this.anchor || { s: 0, o: 0 });
    $$('.toc-list li.cur', this.ui.tocBody).forEach(l => l.classList.remove('cur'));
    const li = $(`.toc-list li[data-i="${i}"]`, this.ui.tocBody);
    if (li) { li.classList.add('cur'); if (scroll) { const b = this.ui.tocBody; b.scrollTop = li.offsetTop - b.clientHeight / 2 + li.offsetHeight / 2; } }
  }
  #thumbGrid() {
    const grid = h('div', { class: 'thumbs' });
    const n = this.doc.n, step = Math.max(1, Math.ceil(n / 60));
    const io = new IntersectionObserver(es => es.forEach(async e => {
      if (!e.isIntersecting || e.target.dataset.done) return; e.target.dataset.done = 1; io.unobserve(e.target);
      const c = await this.doc.thumb(+e.target.dataset.p); e.target.prepend(c);
    }), { root: this.ui.tocBody, rootMargin: '200px' });
    for (let p = 0; p < n; p += step) {
      const b = h('button', { class: 'thumb', dataset: { p }, onclick: () => { this.#closeSheets(); this.go({ page: p }); } }, h('span', null, p + 1));
      grid.append(b); io.observe(b);
    }
    return grid;
  }
  async #gotoToc(e) {
    this.#closeSheets();
    this.#chrome(false);
    if (this.doc.kind === 'pdf') return this.go({ page: e.page });
    this.go(await this.doc.anchorOfToc(e));
  }
  #sortedNotes() {
    const y = n => n.quads?.[0]?.[1] ?? n.rect?.[3] ?? 0;
    return this.notes.filter(n => !n.del).sort((a, b) => (a.page ?? -1) - (b.page ?? -1) || (a.s ?? 0) - (b.s ?? 0) || (a.a ?? 0) - (b.a ?? 0) || y(b) - y(a));
  }
  #exportNotes() {
    const lines = [`# ${this.book.title}`, this.book.author ? `\n${this.book.author}\n` : ''];
    let last = '';
    for (const n of this.#sortedNotes()) {
      if (n.label !== last) { lines.push(`\n## ${n.label}\n`); last = n.label; }
      if (n.text) lines.push(`> ${n.text.replace(/\n/g, '\n> ')}\n`);
      if (n.note) lines.push(`${n.by ? `**${n.by}**：` : ''}${n.note}\n`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${this.book.title} · 笔记.md` }); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------- 排版面板 ----------
  #renderTypePanel() {
    const s = store.settings, pdf = this.doc?.kind === 'pdf';
    const seg = (key, opts, extra = {}) => h('div', { class: 'seg', role: 'radiogroup' }, opts.map(([v, label, ic]) =>
      h('button', { class: s[key] === v ? 'on' : '', role: 'radio', 'aria-checked': s[key] === v, html: (ic ? icon(ic) : '') + `<span>${label}</span>`, onclick: () => { store.set({ [key]: v, ...extra }); this.#renderTypePanel(); } })));
    const toggle = (key, label) => h('label', { class: 'switch-row' }, h('span', null, label), h('input', { type: 'checkbox', class: 'switch', checked: key === 'pdfCrop' ? cropOn() : !!s[key], onchange: e => store.set({ [key]: e.target.checked }) }));
    const row = (label, ...kids) => h('div', { class: 'row' }, h('div', { class: 'row-l' }, label), h('div', { class: 'row-c' }, ...kids));
    const themes = h('div', { class: 'swatches' }, [['auto', '随时', null], ...THEMES.map(t => [t.id, t.name, t])].map(([id, name, t]) =>
      h('button', { class: 'theme-sw' + (s.theme === id ? ' on' : '') + (id === 'auto' ? ' auto' : ''), style: t ? { '--sw-bg': t.paper, '--sw-ink': t.ink } : null, onclick: () => { store.set({ theme: id }); this.#renderTypePanel(); } }, h('i', null, id === 'auto' ? '' : '文'), h('span', null, name))));
    const body = [row('主题', themes)];
    if (this.book?.format === 'pdf') {
      // 有文字层的 PDF 可以重排；扫描版只能按原页读
      const reflow = !!this.doc?.book?.reflow, textual = reflow || this.doc?.textualKnown;
      if (!reflow && textual == null && this.doc?.textual) this.doc.textual().then(() => this.sheet === 'type' && this.#renderTypePanel());
      const mode = h('div', { class: 'seg', role: 'radiogroup' }, [[false, '原版', 'page'], [true, '重排', 'text']].map(([v, label, ic]) =>
        h('button', { class: reflow === v ? 'on' : '', role: 'radio', 'aria-checked': reflow === v, disabled: v && textual === false, html: icon(ic) + `<span>${label}</span>`, onclick: () => this.#setReflow(v) })));
      body.push(row('版面', mode, h('p', { class: 'row-note' }, reflow ? '按文字重新排版，字号、行距、页边随你调；图表与公式请切回原版。' : textual === false ? '这是扫描版，没有文字可重排；可以裁去白边、加深字迹。' : textual ? '「重排」把页面文字重新排版，手机上读起来更舒服。' : '正在查看这份 PDF 是否带文字…')));
    }
    if (!pdf) {
      const size = h('input', { type: 'range', min: 14, max: 30, step: 1, value: s.fontSize, class: 'slider', oninput: e => { sizeVal.textContent = e.target.value; this.#pendingSize(+e.target.value); } });
      const sizeVal = h('b', { class: 'val' }, s.fontSize);
      body.push(
        row('字号', h('div', { class: 'size-row' }, h('button', { class: 'ib sm a-', onclick: () => { store.set({ fontSize: clamp(s.fontSize - 1, 14, 30) }); this.#renderTypePanel(); } }, 'A'), size, h('button', { class: 'ib sm a+', onclick: () => { store.set({ fontSize: clamp(s.fontSize + 1, 14, 30) }); this.#renderTypePanel(); } }, 'A'), sizeVal)),
        row('字体', seg('font', [['serif', '宋'], ['kai', '楷'], ['sans', '黑']])),
        row('行距', seg('lineHeight', [[1.55, '紧'], [1.8, '适中'], [2.05, '舒展'], [2.3, '疏朗']])),
        row('页边', seg('margin', [[0, '窄'], [1, '适中'], [2, '宽']])),
        row('段落', h('div', { class: 'toggles' }, toggle('indent', '首行缩进'), toggle('justify', '两端对齐'))),
      );
    }
    // 阅读方式：左右翻页 / 上下滑动（单页连续，适合放大看 PDF）
    const scrollOn = s.turn === 'scroll';
    const lastTurn = () => { const t = localStorage.getItem('zb-turn'); return t && t !== 'scroll' ? t : 'curl'; };
    body.push(row('方式', h('div', { class: 'seg', role: 'radiogroup' }, [[false, '左右翻页', 'pages'], [true, '上下滑动', 'scroll']].map(([v, label, ic]) =>
      h('button', { class: scrollOn === v ? 'on' : '', role: 'radio', 'aria-checked': scrollOn === v, html: icon(ic) + `<span>${label}</span>`, onclick: () => {
        if (v === scrollOn) return;
        if (v) localStorage.setItem('zb-turn', s.turn);
        store.set({ turn: v ? 'scroll' : lastTurn() }); this.#renderTypePanel();
      } })))));
    if (!scrollOn) body.push(
      row('翻页', seg('turn', TURNS.filter(([v]) => v !== 'scroll').map(([v, l]) => [v, l]))),
      row('版式', seg('spread', [['auto', '自动', null], ['single', '单页', 'page'], ['double', '双页', 'pages']])),
    );
    if (pdf) body.push(
      row('字迹', seg('pdfInk', [[0, '原样'], [1, '加深'], [2, '浓墨']])),
      row('页面', h('div', { class: 'toggles' }, toggle('pdfCrop', '裁去白边'), toggle('pdfTint', '纸色随主题'))));
    body.push(
      row('亮度', h('input', { type: 'range', min: 0, max: .7, step: .01, value: s.dim, class: 'slider dim', oninput: e => store.set({ dim: +e.target.value }) })),
      row('', h('div', { class: 'toggles' }, toggle('keepAwake', '阅读时屏幕常亮'), toggle('calm', '减弱动效'))),
    );
    this.ui.typeBody.replaceChildren(...body);
  }
  async #setReflow(on) {
    const book = this.book, doc = this.doc;
    if (!doc || !!doc.book?.reflow === on) return;
    store.setPref(book.id, { reflow: on });
    this.#closeSheets();
    this.#endSession(); this.#saveNow();
    const pdf = doc.kind === 'pdf' ? doc : doc.book.pdf;
    this.view?.destroy(); this.view = null;
    if (doc.kind === 'flow') { doc.book.pdf = null; doc.destroy(); }
    this.doc = null;
    await this.open(book, { pdf }).catch(() => {});
  }
  #pendingSize = debounce(v => store.set({ fontSize: v }), 220);

  // ---------- 书内搜索 ----------
  #openSearch(q) {
    this.#openSheet('search');
    if (q != null) { this.ui.q.value = q; this.#runSearch(); }
  }
  #runSearch = debounce(() => {
    this.searchAbort?.abort();
    const q = this.ui.q.value.trim();
    const list = this.ui.results;
    list.replaceChildren();
    this.ui.searchInfo.textContent = '';
    if (!this.doc) return;
    if (q.length < 1) { this.doc.kind === 'flow' && this.doc.setHits(null); return; }
    const ac = this.searchAbort = new AbortController();
    let n = 0, lastTitle = null;
    const frag = [];
    const flush = () => { list.append(...frag.splice(0)); this.ui.searchInfo.textContent = n ? `找到 ${n >= 500 ? '500+' : n} 处` : '正在查找…'; };
    const flushT = setInterval(flush, 120);
    this.ui.searchInfo.textContent = '正在查找…';
    this.doc.search(q, r => {
      if (r.scanned) { this.ui.searchInfo.textContent = '这份 PDF 是扫描图像，没有可搜索的文字。'; ac.abort(); return; }
      n++;
      if (r.title !== lastTitle) { frag.push(h('li', { class: 'res-head' }, r.title)); lastTitle = r.title; }
      frag.push(h('li', null, h('button', { onclick: () => this.#gotoHit(r, q) }, h('span', { class: 'ctx', html: esc(r.before) + '<mark>' + esc(r.match) + '</mark>' + esc(r.after) }))));
    }, ac.signal).finally(() => { clearInterval(flushT); if (ac.signal.aborted && n === 0) return; flush(); this.ui.searchInfo.textContent = n ? `找到 ${n >= 500 ? '500+' : n} 处` : `没有找到「${q}」`; });
  }, 350);
  async #gotoHit(r, q) {
    if (isTouch) this.#closeSheets();
    if (this.doc.kind === 'pdf') { this.doc.setHit({ page: r.page, q }); await this.go({ page: r.page }); }
    else { this.doc.setHits({ s: r.s, ranges: [[r.o, r.o + r.len]] }); await this.go({ s: r.s, o: r.o }); }
  }

  // ================= 设置变化 =================
  async onSettings(s, remote, patch = {}) {
    if (this.root.hidden || !this.doc) return;
    applyTheme(s);
    this.#applyType();
    const keys = Object.keys(patch);
    const relayoutKeys = ['font', 'fontSize', 'lineHeight', 'paraSpace', 'indent', 'justify', 'margin', 'spread'];
    if (keys.includes('turn')) {
      const wasScroll = !(this.view instanceof Pager), isScroll = s.turn === 'scroll';
      if (wasScroll !== isScroll) { await this.#mountView(this.anchor); return; }
      this.view.setEffect?.(s.turn);
    }
    if (keys.includes('pdfCrop') && this.doc.kind === 'pdf') {
      if (cropOn()) await this.doc.computeCrop(); else this.doc.crop = null;
      await this.#mountView(this.anchor); return;
    }
    if (keys.some(k => relayoutKeys.includes(k)) || remote) this.#relayout();
    if (keys.includes('keepAwake')) this.#wake();
  }
  #applyType() {
    const s = store.settings, r = this.root.style;
    r.setProperty('--r-fs', s.fontSize + 'px');
    r.setProperty('--r-lh', s.lineHeight);
    r.setProperty('--r-para', s.paraSpace + 'em');
    r.setProperty('--r-indent', s.indent ? '2em' : '0');
    r.setProperty('--r-align', s.justify ? 'justify' : 'start');
    r.setProperty('--r-dim', s.dim);
    this.root.dataset.font = s.font;
    this.root.classList.toggle('pdf-tint', !!s.pdfTint);
    r.setProperty('--pdf-boost', ['contrast(1)', 'contrast(1.35) brightness(.98)', 'contrast(1.8) brightness(.94)'][s.pdfInk || 0]);
  }
  #relayout = debounce(async () => {
    if (!this.doc || !this.view) return;
    if (this.view.t) { this.#relayout(); return; } // 正在翻页时稍后再排
    const a = this.anchor;
    if (this.view instanceof Pager) await this.#mountView(a);
    else { this.#layoutDoc(); await this.view.relayout(); }
  }, 140);

  // ================= 会话：计时 / 常亮 / 快捷键 =================
  #startSession() {
    this.lastActive = Date.now();
    clearInterval(this.tick);
    this.tick = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - this.lastActive < 180e3 && this.book) store.addReading(this.book.id, 15);
    }, 15e3);
    this.#wake();
  }
  #endSession() { clearInterval(this.tick); this.wakeLock?.release?.().catch(() => {}); this.wakeLock = null; }
  async #wake() {
    try {
      if (store.settings.keepAwake && !this.root.hidden && document.visibilityState === 'visible' && 'wakeLock' in navigator) { if (!this.wakeLock) { this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); } }
      else { await this.wakeLock?.release(); this.wakeLock = null; }
    } catch {}
  }
  #hint() {
    if (localStorage.getItem('zb-hint')) return;
    localStorage.setItem('zb-hint', '1');
    setTimeout(() => toast(isTouch ? '轻点中间唤出菜单，左右轻点或滑动翻页' : '点按页面中部唤出菜单 · ← → 翻页 · T 目录 · / 搜索', { duration: 4200 }), 900);
  }

  #wire() {
    const ui = this.ui;
    ui.back.onclick = () => this.onExit?.();
    ui.searchBtn.onclick = () => this.#openSearch();
    ui.markBtn.onclick = () => this.toggleMark();
    ui.prevCh.onclick = () => this.#jumpChapter(-1);
    ui.nextCh.onclick = () => this.#jumpChapter(1);
    ui.ret.onclick = () => { ui.ret.classList.remove('show'); const r = this.returnTo; this.returnTo = null; r && this.go(r, { remember: false }); };
    ui.endBack.onclick = () => this.onExit?.();
    ui.endStay.onclick = () => this.root.classList.remove('ended');
    ui.scrim.onclick = () => this.#closeSheets();
    ui.neScrim.onclick = () => this.#closeEditor(null);
    ui.zoomPill.onclick = e => {
      const z = e.target.closest('[data-z]')?.dataset.z, v = this.view;
      if (!z || !v?.setZoom) return;
      if (z === 'fit') v.fitWidth(); else v.setZoom(v.zoom * (z === 'in' ? 1.2 : 1 / 1.2));
    };
    for (const b of $$('.r-tools .tool', this.root)) b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'toc') { this.#tab = 'toc'; this.#openSheet('toc'); }
      else if (act === 'type') this.#openSheet('type');
      else if (act === 'night') toggleNight();
      else if (act === 'full') this.#fullscreen();
    };
    for (const b of $$('.tabs button', ui.tocSheet)) b.onclick = () => { this.#tab = b.dataset.tab; this.#renderTocPanel(); };
    ui.q.addEventListener('input', () => this.#runSearch());
    ui.q.addEventListener('keydown', e => { if (e.key === 'Enter') { this.#runSearch.flush(); } if (e.key === 'Escape') this.#closeSheets(); });
    ui.searchClose.onclick = () => { this.#closeSheets(); };
    ui.typeClose.onclick = () => this.#closeSheets();
    ui.tocClose.onclick = () => this.#closeSheets();
    for (const sh of $$('.sheet', this.root)) sheetDrag(sh, () => this.#closeSheets());

    // 进度条拖动预览
    const r = ui.range;
    r.addEventListener('input', () => { this.scrubbing = true; this.#preview(+r.value / 1000); });
    r.addEventListener('change', async () => {
      const f = +r.value / 1000; this.scrubbing = false; ui.bubble.classList.remove('show');
      if (this.doc.kind === 'pdf') this.go({ page: Math.round(f * (this.doc.n - 1)) });
      else this.go(await this.doc.anchorOfProgress(f));
    });
    r.addEventListener('pointerup', () => setTimeout(() => ui.bubble.classList.remove('show'), 400));

    document.addEventListener('selectionchange', () => this.#onSelection());
    document.addEventListener('keydown', e => this.#key(e));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { this.#wake(); this.lastActive = Date.now(); } else this.#saveNow(); });
    for (const ev of ['pointerdown', 'keydown', 'wheel']) this.root.addEventListener(ev, () => { this.lastActive = Date.now(); }, { passive: true });
    new ResizeObserver(() => {
      const size = this.stage.clientWidth + 'x' + this.stage.clientHeight;
      if (size === this.lastSize || this.root.hidden) return;
      if (this.view) this.#relayout();
    }).observe(this.stage);

    // 鼠标静止后隐藏光标
    let ct; this.root.addEventListener('mousemove', () => { this.root.classList.remove('nocursor'); clearTimeout(ct); ct = setTimeout(() => this.root.classList.add('nocursor'), 2200); });
  }
  async #preview(f) {
    const b = this.ui.bubble; b.classList.add('show');
    b.style.setProperty('--f', f);
    const t = $('.r-bubble-thumb', b);
    if (this.doc.kind === 'pdf') {
      const p = Math.round(f * (this.doc.n - 1));
      $('b', b).textContent = `第 ${p + 1} 页`; $('span', b).textContent = (this.toc || []).filter(e => e.page <= p).pop()?.label || '';
      clearTimeout(this.thumbT);
      this.thumbT = setTimeout(async () => { const c = await this.doc.thumb(p, 96); if (+this.ui.range.value / 1000 === f) t.replaceChildren(copy(c)); }, 90);
    } else {
      t.replaceChildren();
      const total = this.doc.sizes.reduce((a, b) => a + (b || 1), 0); let acc = 0, s = 0;
      for (; s < this.doc.n - 1; s++) { if (acc + (this.doc.sizes[s] || 1) >= f * total) break; acc += this.doc.sizes[s] || 1; }
      $('b', b).textContent = pct(f); $('span', b).textContent = this.doc.sectionTitle(s);
    }
  }
  async #jumpChapter(dir) {
    if (!this.anchor || !this.doc) return;
    if (this.doc.kind === 'pdf') {
      const p = this.anchor.page, toc = this.toc || [];
      const target = dir > 0 ? toc.find(e => e.page > p) : [...toc].reverse().find(e => e.page < p - (this.view instanceof Pager && this.doc.L.spread ? 1 : 0));
      if (target) this.go({ page: target.page }); else this.go({ page: dir > 0 ? this.doc.n - 1 : 0 });
      return;
    }
    const s = clamp(this.anchor.s + dir, 0, this.doc.n - 1);
    if (dir < 0 && this.anchor.o > 200) return this.go({ s: this.anchor.s, o: 0 });
    this.go({ s, o: 0 });
  }
  #fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => toast('此设备不支持全屏'));
  }
  #key(e) {
    if (this.root.hidden || !this.doc) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' && e.target.type !== 'range' || tag === 'TEXTAREA') return;
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (mod && (k === 'f' || k === 'F')) { e.preventDefault(); this.#openSearch(); return; }
    if (mod) return;
    const scroll = !(this.view instanceof Pager);
    switch (k) {
      case 'ArrowRight': case 'PageDown': if (scroll && k === 'ArrowRight') return; e.preventDefault(); this.turn(1); break;
      case 'ArrowLeft': case 'PageUp': if (scroll && k === 'ArrowLeft') return; e.preventDefault(); this.turn(-1); break;
      case ' ': e.preventDefault(); this.turn(e.shiftKey ? -1 : 1); break;
      case 'ArrowDown': if (!scroll) { e.preventDefault(); this.turn(1); } break;
      case 'ArrowUp': if (!scroll) { e.preventDefault(); this.turn(-1); } break;
      case 'Escape':
        if (this.ui.selPop.classList.contains('show') || this.ui.notePop.classList.contains('show')) { this.#hideSel(true); this.ui.notePop.classList.remove('show'); }
        else if (this.sheet) this.#closeSheets(); else if (this.root.classList.contains('chrome')) this.#chrome(false); else this.onExit?.();
        break;
      case 't': case 'T': this.#tab = 'toc'; this.#openSheet('toc'); break;
      case '/': e.preventDefault(); this.#openSearch(); break;
      case 'b': case 'B': this.toggleMark(); break;
      case 'f': case 'F': this.#fullscreen(); break;
      case 'd': case 'D': $('[data-act="night"]', this.root).click(); break;
      case 'm': case 'M': this.#chrome(!this.root.classList.contains('chrome')); break;
      case '+': case '=': if (this.doc.kind === 'flow') store.set({ fontSize: clamp(store.settings.fontSize + 1, 14, 30) }); else this.view?.setZoom?.(this.view.zoom * 1.2); break;
      case '-': if (this.doc.kind === 'flow') store.set({ fontSize: clamp(store.settings.fontSize - 1, 14, 30) }); else this.view?.setZoom?.(this.view.zoom / 1.2); break;
      case '0': this.view?.fitWidth?.(); break;
      case 'Home': if (!scroll) this.go(this.doc.kind === 'pdf' ? { page: 0 } : { s: 0, o: 0 }); break;
    }
  }
}

const cropOn = () => store.settings.pdfCrop === 'auto' ? innerWidth < 600 : !!store.settings.pdfCrop;

export function toggleNight() {
  const s = store.settings;
  if (effectiveTheme(s) === 'ink') {
    let day = localStorage.getItem('zb-day') || 'paper';
    if (effectiveTheme({ theme: day }) === 'ink') day = 'paper';
    store.set({ theme: day });
  } else { localStorage.setItem('zb-day', s.theme); store.set({ theme: 'ink' }); }
}

function copy(c) { const d = document.createElement('canvas'); d.width = c.width; d.height = c.height; d.getContext('2d').drawImage(c, 0, 0); return d; }
function textAt(t, off, n) { let s = ''; for (let i = 0; i < t.nodes.length && s.length < n + off - (t.starts[i] || 0); i++) { if (t.starts[i] + t.nodes[i].length < off) continue; s += t.nodes[i].data.slice(Math.max(0, off - t.starts[i])); } return s.replace(/\s+/g, ' ').trim().slice(0, n); }

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 401 ? '需要书库钥匙' : '取书失败（' + res.status + '）');
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader(); const chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress?.(got / total); }
  return new Blob(chunks);
}

// 底部抽屉：向下拖动关闭
function sheetDrag(sheet, close) {
  const handle = $('.grab', sheet); if (!handle) return;
  let y0 = null, dy = 0;
  handle.addEventListener('pointerdown', e => { if (innerWidth >= 760) return; y0 = e.clientY; dy = 0; handle.setPointerCapture(e.pointerId); sheet.style.transition = 'none'; });
  handle.addEventListener('pointermove', e => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translateY(${dy}px)`; });
  const end = () => { if (y0 == null) return; y0 = null; sheet.style.transition = ''; sheet.style.transform = ''; if (dy > 80) close(); };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}

const TEMPLATE = `
<div class="r-stage" data-ref="stage"></div>
<div class="safe-probe" data-ref="probe" aria-hidden="true"></div>
<div class="r-dim" aria-hidden="true"></div>
<div class="r-hud" aria-hidden="true"><span data-ref="hudL"></span><span data-ref="hudR"></span></div>
<div class="r-ribbon" aria-hidden="true"></div>
<header class="r-top bar">
  <button class="ib" data-ref="back" aria-label="回到书架">${icon('back')}</button>
  <div class="r-title"><b data-ref="title"></b><span data-ref="sub"></span></div>
  <button class="ib" data-ref="searchBtn" aria-label="书内搜索">${icon('search')}</button>
  <button class="ib" data-ref="markBtn" aria-label="书签">${icon('bookmark')}</button>
</header>
<footer class="r-bottom bar">
  <div class="r-prog">
    <button class="ib sm" data-ref="prevCh" aria-label="上一章">${icon('back')}</button>
    <div class="r-slider">
      <input type="range" min="0" max="1000" step="1" value="0" data-ref="range" aria-label="阅读进度">
      <div class="r-bubble" data-ref="bubble"><div class="r-bubble-thumb"></div><b></b><span></span></div>
    </div>
    <button class="ib sm" data-ref="nextCh" aria-label="下一章">${icon('chevron')}</button>
  </div>
  <nav class="r-tools">
    <button class="tool" data-act="toc">${icon('toc')}<span>目录</span></button>
    <button class="tool" data-act="type">${icon('type')}<span>排版</span></button>
    <button class="tool" data-act="night">${icon('moon')}<span>夜读</span></button>
    <button class="tool desk-only" data-act="full">${icon('expand')}<span>全屏</span></button>
  </nav>
</footer>
<div class="scrim" data-ref="scrim"></div>
<section class="sheet left" data-ref="tocSheet" aria-label="目录">
  <div class="grab"></div>
  <div class="sheet-head"><div><b data-ref="tocHead"></b><span data-ref="tocMeta"></span></div><button class="ib sm" data-ref="tocClose" aria-label="关闭">${icon('close')}</button></div>
  <div class="tabs"><button data-tab="toc">目录</button><button data-tab="marks">书签</button><button data-tab="notes">笔记</button></div>
  <div class="sheet-body" data-ref="tocBody"></div>
</section>
<section class="sheet float" data-ref="typeSheet" aria-label="排版">
  <div class="grab"></div>
  <div class="sheet-head"><div><b>阅读设置</b></div><button class="ib sm" data-ref="typeClose" aria-label="关闭">${icon('close')}</button></div>
  <div class="sheet-body type-body" data-ref="typeBody"></div>
</section>
<section class="sheet right" data-ref="searchSheet" aria-label="书内搜索">
  <div class="grab"></div>
  <div class="sheet-head search-head"><div class="field">${icon('search')}<input data-ref="q" type="search" placeholder="在书中查找" enterkeyhint="search" autocomplete="off"></div><button class="ib sm" data-ref="searchClose" aria-label="关闭">${icon('close')}</button></div>
  <div class="search-info" data-ref="searchInfo"></div>
  <ul class="sheet-body results" data-ref="results"></ul>
</section>
<div class="pop sel-pop" data-ref="selPop"></div>
<div class="pop note-pop" data-ref="notePop"></div>
<div class="ne-scrim" data-ref="neScrim"></div>
<section class="note-editor" data-ref="editor" role="dialog" aria-modal="true" aria-label="笔记"></section>
<div class="zoom-pill" data-ref="zoomPill" role="group" aria-label="缩放">
  <button class="ib sm" data-z="out" aria-label="缩小">${icon('minus')}</button>
  <button class="zv" data-z="fit" title="适应宽度" data-ref="zoomVal">100%</button>
  <button class="ib sm" data-z="in" aria-label="放大">${icon('plus')}</button>
</div>
<button class="pill r-return" data-ref="ret"></button>
<div class="r-loading"><div class="ink-drop"><i></i><i></i><i></i></div><span data-ref="loadMsg"></span></div>
<div class="r-end" role="dialog" aria-label="读完了">
  <div class="end-card">
    <div class="end-mark"></div>
    <h2>读完了</h2>
    <p data-ref="endStats"></p>
    <div class="end-acts"><button class="btn ghost" data-ref="endStay">再看看</button><button class="btn" data-ref="endBack">回到书架</button></div>
  </div>
</div>`;

// 两次划线是否压在同一段文字上（任一行框相交即算）
function overlapQuads(a = [], b = []) {
  const box = q => [Math.min(q[0], q[4]), Math.min(q[5], q[7]), Math.max(q[2], q[6]), Math.max(q[1], q[3])];
  return a.some(p => b.some(q => { const [a0, a1, a2, a3] = box(p), [b0, b1, b2, b3] = box(q); return a0 < b2 && b0 < a2 && a1 < b3 && b1 < a3 && Math.min(a3, b3) - Math.max(a1, b1) > (a3 - a1) * .5; }));
}
