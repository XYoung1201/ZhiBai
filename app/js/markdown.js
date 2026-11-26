import { Marked } from '../vendor/marked.esm.js';
import temml from '../vendor/temml/temml.mjs';
import { htmlToBook, decodeText } from './formats.js';
import { readZip, normPath, dirOf, mimeOf } from './mdcopy.js';

// Tokenize before Markdown can consume TeX escapes, underscores and alignment rows.
const ENV = 'equation|align|alignat|gather|multline|eqnarray|flalign';
const blockMath = new RegExp('^ {0,3}(?:\\$\\$([\\s\\S]+?)\\$\\$|\\\\\\[([\\s\\S]+?)\\\\\\]|(\\\\begin\\{(' + ENV + ')\\*?\\}[\\s\\S]+?\\\\end\\{\\4\\*?\\}))[ \\t]*(?:\\n|$)');
// 行内：$$…$$ 夹在文字中间时仍按独立公式排版（含公式后紧跟标点或正文的情况）
const displayInline = /^\$\$([\s\S]+?)\$\$/;
const inlineMath = /^(?:\\\(((?:\\(?!\))[^\n]|[^\\\n])+)\\\)|\$(?![\s$])((?:\\[^\n]|[^$\\\n]|\n(?![ \t]*\n))+?)(?<!\s)\$(?![\d$]))/;

function mathExtension(name, level, opener, pattern, display) {
  return {
    name, level,
    start(src) { return src.search(opener); },
    tokenizer(src) {
      const m = pattern.exec(src);
      if (m) return { type: name, raw: m[0], text: m[1] ?? m[2] ?? m[3] };
    },
    renderer(token) {
      const tex = token.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const tag = level === 'block' ? 'div' : 'span';
      return '<' + tag + ' data-zb-tex' + (display && level !== 'block' ? ' data-zb-display' : '') + '>' + tex + '</' + tag + '>';
    },
  };
}

// 中文友好的行内格式。CommonMark 的「左右侧定界」规则在中文标点旁会失效，例如「**加粗：**后文」「中文**“引号”**中文」
// 都不会加粗。这里放宽为：成对标记之间的内容首尾不是空白即可。下划线写法只在内容含中日韩文字时放宽，避免误伤 snake_case。
// 内容里的转义、行内代码与行内公式整体跳过，不会被拆开。
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const BODY = '((?:\\\\[\\s\\S]|`[^`\\n]+`|\\$[^$\\n]+\\$|[\\s\\S])+?)';
const pair = (open, close = open, extra = '') => new RegExp('^' + open + '(?!\\s)' + BODY + '(?<![\\s\\\\' + extra + '])' + close);
const EMPH = [
  { type: 'strong', re: pair('\\*\\*', '\\*\\*(?!\\*)') },
  { type: 'strong', re: pair('__', '__(?!_)'), cjk: true },
  { type: 'del', re: pair('~~', '~~(?!~)') },
  { type: 'mark', re: pair('==(?!=)', '==(?!=)') },
  { type: 'em', re: pair('\\*(?![*\\s])', '\\*(?!\\*)', '*') },
  { type: 'em', re: pair('_(?![_\\s])', '_(?!_)', '_'), cjk: true },
];
const emphasis = {
  name: 'cjkEmphasis', level: 'inline',
  start(src) { return src.search(/[*_~=]/); },
  tokenizer(src) {
    for (const { type, re, cjk } of EMPH) {
      const m = re.exec(src);
      if (!m || (cjk && !CJK.test(m[1]))) continue;
      return { type, raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
    }
  },
};
const highlight = { name: 'mark', level: 'inline', renderer(token) { return '<mark>' + this.parser.parseInline(token.tokens) + '</mark>'; } };

const markdown = new Marked({
  gfm: true,
  renderer: { checkbox({ checked }) { return checked ? '☑ ' : '☐ '; } },
  extensions: [
    mathExtension('blockMath', 'block', /(?:^|\n) {0,3}(?:\$\$|\\\[|\\begin\{(?:equation|align|alignat|gather|multline|eqnarray|flalign)\*?\})/, blockMath),
    mathExtension('displayMath', 'inline', /\$\$/, displayInline, true),
    mathExtension('inlineMath', 'inline', /\$|\\\(/, inlineMath),
    emphasis, highlight,
  ],
});

// 渲染前清掉 Temml 不认的编号命令；仍失败再退回原文
function cleanTex(tex) {
  return tex.replace(/\\(?:label|nonumber|notag)(?:\{[^}]*\})?/g, '').replace(/\\\\\s*$/, '').trim();
}
function renderMath(el, tex, displayMode) {
  const opts = { displayMode, trust: false, throwOnError: true, strict: false, maxExpand: 1000, maxSize: [50, 50] };
  el.dataset.tex = tex;
  el.className = displayMode ? 'math-block' : 'math-inline';
  // \tag 会让 Temml 生成 width:100% 的表格，在可横向滚动的容器里会塌成空白：自己排编号
  let tag = null;
  const body = tex.replace(/\\tag(\*?)\{([^}]*)\}/, (m, star, t) => { tag = star ? t : '(' + t + ')'; return ''; });
  try { temml.render(cleanTex(body), el, opts); }
  catch {
    try { el.textContent = ''; temml.render(cleanTex(tex).replace(/\\tag\*?\{[^}]*\}/, ''), el, opts); }
    catch { el.textContent = displayMode ? tex : '$' + tex + '$'; el.classList.add('math-error'); return; }
  }
  if (tag && displayMode) { const t = document.createElement('span'); t.className = 'math-tag'; t.textContent = tag; el.append(t); }
}

const isRemote = u => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

// 只做 Markdown → HTML（公式先占位，不排版）；便于测试，也给需要原始 HTML 的地方用
export const markdownToHtml = source => markdown.parse(source);

// resolveImg(src) → { url, path } | null：压缩包里的配图换成 blob 地址
export function markdownToBook(source, meta, resolveImg) {
  return htmlToBook(markdown.parse(source), meta, body => {
    // Add generated MathML after sanitization so its layout styles survive.
    for (const el of body.querySelectorAll('div[data-zb-tex], span[data-zb-tex]')) {
      const displayMode = el.tagName === 'DIV' || el.hasAttribute('data-zb-display');
      const tex = el.textContent;
      el.removeAttribute('data-zb-tex'); el.removeAttribute('data-zb-display');
      renderMath(el, tex, displayMode);
    }
    if (resolveImg) for (const img of body.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (isRemote(src)) continue;
      const r = resolveImg(src);
      if (r) { img.setAttribute('data-zb-src', r.path); img.setAttribute('src', r.url); }
    }
  });
}

// ---------- 压缩包：Markdown + 配图等资源 ----------
function rebase(text, dir) {
  const fix = u => { u = u.replace(/^<|>$/g, ''); return isRemote(u) ? null : encodeURI(normPath((dir ? dir + '/' : '') + safeDecode(u.split(/[?#]/)[0]))); };
  return text
    .replace(/(!\[[^\]]*\]\(\s*)(<[^>]*>|[^)\s]+)/g, (m, a, u) => { const f = fix(u); return f == null ? m : a + f; })
    .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, u) => { const f = fix(u); return f == null ? m : a + q + f + q; });
}
const safeDecode = u => { try { return decodeURIComponent(u); } catch { return u; } };

export async function markdownZipToBook(blob, meta) {
  const files = await readZip(blob);
  const mds = [...files.keys()].filter(n => /\.(md|markdown)$/i.test(n))
    .sort((a, b) => a.split('/').length - b.split('/').length || (/(^|\/)(readme|index)\./i.test(b) - /(^|\/)(readme|index)\./i.test(a)) || a.localeCompare(b, 'zh'));
  if (!mds.length) throw new Error('压缩包里没有找到 Markdown 文件');
  const lower = new Map([...files.keys()].map(k => [k.toLowerCase(), k]));
  const urls = new Map();
  const resolveImg = src => {
    const want = normPath(safeDecode(src.split(/[?#]/)[0]));
    const path = files.has(want) ? want : lower.get(want.toLowerCase());
    if (!path) return null;
    if (!urls.has(path)) urls.set(path, URL.createObjectURL(new Blob([files.get(path)], { type: mimeOf(path) })));
    return { url: urls.get(path), path };
  };
  const source = mds.map(n => rebase(decodeText(files.get(n)), dirOf(n))).join('\n\n');
  const book = markdownToBook(source, meta, resolveImg);
  book.assets = files;
  const destroy = book.destroy;
  book.destroy = () => { for (const u of urls.values()) URL.revokeObjectURL(u); destroy?.call(book); };
  return book;
}
