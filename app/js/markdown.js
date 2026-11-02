import { Marked } from '../vendor/marked.esm.js';
import temml from '../vendor/temml/temml.mjs';
import { htmlToBook } from './formats.js';

// Tokenize before Markdown can consume TeX escapes, underscores and alignment rows.
const blockMath = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;
const inlineMath = /^(?:\\\(((?:\\(?!\))[^\n]|[^\\\n])+)\\\)|\$(?![\s$])((?:\\[^\n]|[^$\\\n])+?)(?<!\s)\$(?![\d$]))/;

function mathExtension(name, level, opener, pattern) {
  return {
    name, level,
    start(src) { return src.search(opener); },
    tokenizer(src) {
      const m = pattern.exec(src);
      if (m) return { type: name, raw: m[0], text: m[1] ?? m[2] };
    },
    renderer(token) {
      const tex = token.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const tag = level === 'block' ? 'div' : 'span';
      return '<' + tag + ' data-zb-tex>' + tex + '</' + tag + '>';
    },
  };
}

const markdown = new Marked({
  gfm: true,
  renderer: { checkbox({ checked }) { return checked ? '☑ ' : '☐ '; } },
  extensions: [
    mathExtension('blockMath', 'block', /(?:^|\n) {0,3}(?:\$\$|\\\[)/, blockMath),
    mathExtension('inlineMath', 'inline', /\$|\\\(/, inlineMath),
  ],
});

export function markdownToBook(source, meta) {
  return htmlToBook(markdown.parse(source), meta, body => {
    // Add generated MathML after sanitization so its layout styles survive.
    for (const el of body.querySelectorAll('div[data-zb-tex], span[data-zb-tex]')) {
      const displayMode = el.tagName === 'DIV';
      const tex = el.textContent;
      el.removeAttribute('data-zb-tex');
      el.className = displayMode ? 'math-block' : 'math-inline';
      try {
        temml.render(tex, el, { displayMode, trust: false, throwOnError: true, maxExpand: 1000, maxSize: [50, 50] });
      } catch {
        el.textContent = tex;
        el.classList.add('math-error');
      }
    }
  });
}
