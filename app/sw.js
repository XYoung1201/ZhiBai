// 知白 · 离线外壳：页面与脚本走「网络优先、断网回退缓存」；字体与库走缓存优先
const V = 'zb-v1';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/main.js', 'js/util.js', 'js/db.js', 'js/store.js', 'js/library.js', 'js/reader.js', 'js/pager.js', 'js/flow.js', 'js/pdfdoc.js', 'js/formats.js', 'js/markdown.js', 'vendor/temml/Temml-Local.css', 'js/opener.js', 'js/theme.js', 'icons/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('zb-') && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  const long = /\/(vendor|fonts|icons)\//.test(url.pathname);
  if (long) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => { if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(V).then(c => c.put(e.request, copy)); } return res; })));
    return;
  }
  e.respondWith(fetch(e.request).then(res => { if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(V).then(c => c.put(e.request, copy)); } return res; }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
