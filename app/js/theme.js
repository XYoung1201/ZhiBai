import { icon } from './util.js';

// 四种纸色；「随时」按时辰流转：日间素纸、黄昏宣纸、入夜墨色
export const THEMES = [
  { id: 'paper', name: '素', paper: '#FAF8F3', ink: '#24221E', meta: '#F3F1EB' },
  { id: 'rice', name: '宣', paper: '#F3EAD8', ink: '#3B3125', meta: '#EAE0CB' },
  { id: 'jade', name: '青', paper: '#E4ECE3', ink: '#24322B', meta: '#D9E3D8' },
  { id: 'ink', name: '墨', paper: '#1C1B19', ink: '#C9C3B6', meta: '#141412' },
];
export function effectiveTheme(s) {
  if (s.theme === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'ink' : 'paper';
  if (s.theme !== 'auto') return s.theme;
  const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
  if (m >= 6 * 60 && m < 17 * 60 + 30) return 'paper';
  if (m >= 17 * 60 + 30 && m < 20 * 60 + 30) return 'rice';
  return 'ink';
}
let timer;
export function applyTheme(s) {
  const id = effectiveTheme(s);
  try { localStorage.setItem('zb-theme-hint', JSON.stringify(s.theme)); } catch {}
  const root = document.documentElement;
  root.classList.toggle('calm', !!s.calm);
  if (root.dataset.theme !== id) {
    root.classList.add('theme-shift');
    root.dataset.theme = id;
    clearTimeout(timer); timer = setTimeout(() => root.classList.remove('theme-shift'), 700);
  }
  const t = THEMES.find(x => x.id === id);
  const reading = root.classList.contains('reading');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', reading ? t.paper : t.meta);
  root.style.colorScheme = id === 'ink' ? 'dark' : 'light';
  syncNightButtons(id);
  return id;
}
// 日读 / 夜读 按钮：显示的是「将切换到」的那一面
function syncNightButtons(id) {
  const night = id === 'ink';
  for (const b of document.querySelectorAll('[data-act="night"]')) {
    if (b.dataset.mode === (night ? 'day' : 'night')) continue;
    const first = !b.dataset.mode;
    b.dataset.mode = night ? 'day' : 'night';
    b.innerHTML = icon(night ? 'sun' : 'moon', first ? '' : 'swap') + `<span>${night ? '日读' : '夜读'}</span>`;
    b.setAttribute('aria-label', night ? '切换到日间' : '切换到夜间');
  }
}
// 「随时」模式下每分钟检查一次时辰
export function watchTime(get) { setInterval(() => { const s = get(); if (s.theme === 'auto') applyTheme(s); }, 60e3); }
