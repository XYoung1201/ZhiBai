// IndexedDB：本机书籍文件、书目、封面、阅读状态、设置
const NAME = 'zhibai', VER = 1;
const STORES = ['files', 'books', 'covers', 'state', 'kv'];
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VER);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function tx(store, mode, fn) {
  try {
    const db = await open();
    return await wrap(fn(db.transaction(store, mode).objectStore(store)));
  } catch (e) { console.warn('idb', store, e); return undefined; }
}

export const db = {
  get: (s, k) => tx(s, 'readonly', o => o.get(k)),
  put: (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)),
  del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
  async entries(s) {
    try {
      const db_ = await open();
      return await new Promise((res, rej) => {
        const out = [], req = db_.transaction(s).objectStore(s).openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
        req.onerror = () => rej(req.error);
      });
    } catch { return []; }
  },
};
