// 应用状态：设置、书目（云端 + 本机）、阅读状态与多端同步
import { db } from './db.js';
import { Emitter, debounce, dayKey, contentId, uid } from './util.js';

export const DEFAULTS = {
  theme: 'auto',        // auto | paper | rice | jade | ink | system
  font: 'serif',        // serif | kai | sans
  fontSize: 19,
  lineHeight: 1.8,
  paraSpace: .5,
  indent: true,
  justify: true,
  margin: 1,            // 0 窄 1 适中 2 宽
  turn: 'curl',         // curl | cover | slide | fade | none | scroll
  spread: 'auto',       // auto | single | double
  pdfTint: true,
  pdfCrop: 'auto',     // auto：手机上自动裁白边
  pdfInk: 0,           // 扫描页字迹加深 0 / 1 / 2
  dim: 0,
  keepAwake: true,
  calm: false,
  sort: 'recent',
  view: 'grid',
};

const api = {
  async req(path, opts = {}) {
    const r = await fetch('api/' + path, { credentials: 'same-origin', ...opts });
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || r.statusText), { status: r.status });
    return r.json();
  },
  session: () => api.req('session').catch(() => ({ authed: false, offline: true })),
  login: key => api.req('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }),
  logout: () => api.req('logout', { method: 'POST' }),
  catalog: () => api.req('catalog'),
  state: () => api.req('state'),
  push: body => api.req('state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: JSON.stringify(body).length < 60000 }),
  setMeta: (id, patch) => api.req('meta/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  remove: id => api.req('book/' + id, { method: 'DELETE' }),
  postCover: (id, blob) => fetch('api/cover/' + id, { method: 'POST', body: blob }).catch(() => {}),
  fileUrl: id => new URL('api/file/' + id, location.href).href,
  coverUrl: id => 'api/cover/' + id,
  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', 'api/upload?name=' + encodeURIComponent(file.name));
      x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => { try { const j = JSON.parse(x.responseText); x.status < 300 ? resolve(j) : reject(new Error(j.error || x.statusText)); } catch (e) { reject(e); } };
      x.onerror = () => reject(new Error('网络中断'));
      x.send(file);
    });
  },
};
export { api };

class Store extends Emitter {
  settings = { ...DEFAULTS };
  books = new Map();      // id -> book
  states = new Map();     // id -> { progress, marks, notes, stats }
  categories = [];
  authed = false;
  offline = false;
  device = localStorage.getItem('zb-device') || (() => { const d = uid(); localStorage.setItem('zb-device', d); return d; })();
  #dirty = new Set();
  #settingsDirty = false;

  async init() {
    const saved = await db.get('kv', 'settings');
    if (saved) this.settings = { ...DEFAULTS, ...saved };
    for (const [id, st] of await db.entries('state')) this.states.set(id, st);
    for (const [id, b] of await db.entries('books')) this.books.set(id, { ...b, id, local: true });
    const cached = await db.get('kv', 'catalog');
    if (cached) this.#applyCatalog(cached, false);
    const s = await api.session();
    this.authed = !!s.authed; this.offline = !!s.offline;
    if (this.authed) this.refresh();
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.sync.flush(); else if (this.authed) this.pull(); });
    addEventListener('online', () => this.authed && this.sync());
  }

  async refresh() {
    try {
      const cat = await api.catalog();
      await db.put('kv', 'catalog', cat);
      this.#applyCatalog(cat, true);
      await this.pull();
    } catch (e) { if (e.status === 401) { this.authed = false; this.emit('auth'); } }
  }

  #applyCatalog(cat, emit) {
    for (const [id, b] of this.books) if (!b.local) this.books.delete(id);
    for (const b of cat.books || []) {
      const local = this.books.get(b.id);
      this.books.set(b.id, { ...b, cloud: true, local: !!local?.local, localCover: local?.localCover });
    }
    this.categories = cat.categories || [];
    if (emit) this.emit('books');
  }

  async pull() {
    try {
      const remote = await api.state();
      let changed = false;
      for (const [id, r] of Object.entries(remote.books || {})) {
        const l = this.states.get(id) || {};
        const merged = { ...l };
        for (const k of ['progress', 'marks', 'notes', 'meta']) if (r[k] && (!l[k] || (r[k].t || 0) > (l[k].t || 0))) { merged[k] = r[k]; changed = true; }
        if (r.stats) { merged.stats = { ...(l.stats || {}) }; for (const [dev, days] of Object.entries(r.stats)) { if (dev === this.device) continue; merged.stats[dev] = days; } }
        this.states.set(id, merged); db.put('state', id, merged);
      }
      if (remote.settings && (remote.settings.t || 0) > (this.settings.t || 0)) {
        this.settings = { ...DEFAULTS, ...remote.settings }; db.put('kv', 'settings', this.settings); this.emit('settings', this.settings, true);
      }
      if (changed) this.emit('states');
    } catch {}
  }

  sync = debounce(async () => {
    if (!this.authed || (!this.#dirty.size && !this.#settingsDirty)) return;
    const body = { books: {} };
    for (const id of this.#dirty) {
      const st = this.states.get(id); if (!st) continue;
      body.books[id] = { ...st, stats: st.stats?.[this.device] ? { [this.device]: st.stats[this.device] } : undefined };
    }
    if (this.#settingsDirty) body.settings = this.settings;
    const ids = [...this.#dirty]; this.#dirty.clear(); this.#settingsDirty = false;
    try { await api.push(body); } catch { ids.forEach(i => this.#dirty.add(i)); }
  }, 2500);

  // ---- 设置 ----
  set(patch) {
    Object.assign(this.settings, patch, { t: Date.now() });
    db.put('kv', 'settings', this.settings);
    this.#settingsDirty = true; this.sync();
    this.emit('settings', this.settings, false, patch);
  }

  // ---- 阅读状态 ----
  state(id) { return this.states.get(id) || {}; }
  #save(id, st) { this.states.set(id, st); db.put('state', id, st); this.#dirty.add(id); this.sync(); }
  setProgress(id, progress) {
    const st = { ...this.state(id), progress: { ...progress, t: Date.now() } };
    this.#save(id, st); this.emit('progress', id);
  }
  setMarks(id, items) { this.#save(id, { ...this.state(id), marks: { items, t: Date.now() } }); this.emit('marks', id); }
  // 每本书自己的偏好（如 PDF 是否重排），随书同步
  pref(id) { return this.state(id).meta || {}; }
  setPref(id, patch) { this.#save(id, { ...this.state(id), meta: { ...this.pref(id), ...patch, t: Date.now() } }); }
  setNotes(id, items) { this.#save(id, { ...this.state(id), notes: { items, t: Date.now() } }); this.emit('notes', id); }
  addReading(id, sec) {
    if (sec <= 0) return;
    const st = { ...this.state(id) };
    st.stats = { ...(st.stats || {}) };
    const mine = st.stats[this.device] = { ...(st.stats[this.device] || {}) };
    const k = dayKey(); mine[k] = (mine[k] || 0) + sec;
    this.#save(id, st);
  }
  readingTime(id) {
    let s = 0; for (const days of Object.values(this.state(id).stats || {})) for (const v of Object.values(days)) s += v; return s;
  }
  todayTime() {
    const k = dayKey(); let s = 0;
    for (const st of this.states.values()) for (const days of Object.values(st.stats || {})) s += days[k] || 0;
    return s;
  }

  // ---- 本机书籍 ----
  async addLocal(file, meta) {
    const id = await contentId(file);
    if (this.books.has(id)) return { id, existed: true };
    const book = { id, title: meta.title, author: meta.author || '', format: meta.format, size: file.size, added: Date.now(), category: meta.category || '', local: true, name: file.name };
    await db.put('files', id, file);
    await db.put('books', id, book);
    this.books.set(id, book);
    this.emit('books');
    return { id, existed: false };
  }
  async removeLocal(id) {
    await db.del('files', id); await db.del('books', id); await db.del('covers', id);
    const b = this.books.get(id);
    if (b?.cloud) this.books.set(id, { ...b, local: false }); else this.books.delete(id);
    this.emit('books');
  }
  async updateMeta(id, patch) {
    const b = this.books.get(id); if (!b) return;
    Object.assign(b, patch);
    if (b.local && !b.cloud) await db.put('books', id, { ...b });
    if (b.cloud && this.authed) await api.setMeta(id, patch).catch(() => {});
    this.emit('books');
  }
  async localFile(id) { return db.get('files', id); }
  async coverBlob(id) { return db.get('covers', id); }
  async saveCover(id, blob) {
    await db.put('covers', id, blob);
    const b = this.books.get(id); if (b) b.localCover = true;
    if (b?.cloud && !b.cover && this.authed) api.postCover(id, blob);
  }
}

export const store = new Store();
