import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../app/js/markdown.js';

test('行内公式先占位，下划线不被当成强调', () => {
  const html = markdownToHtml('速度 $v_0 + a_t$ 与 \\(x_1\\)');
  assert.match(html, /<span data-zb-tex>v_0 \+ a_t<\/span>/);
  assert.match(html, /<span data-zb-tex>x_1<\/span>/);
  assert.ok(!html.includes('<em>'));
});

test('独立公式：$$、\\[ \\] 与 align 环境', () => {
  assert.match(markdownToHtml('$$\na^2+b^2=c^2\n$$'), /<div data-zb-tex>\s*a\^2\+b\^2=c\^2\s*<\/div>/);
  assert.match(markdownToHtml('\\[\n\\int_0^1 x\\,dx\n\\]'), /<div data-zb-tex>/);
  const al = markdownToHtml('\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}');
  assert.match(al, /<div data-zb-tex>\\begin\{align\}/);
  assert.ok(!al.includes('<table'));
});

test('夹在文字里的 $$…$$ 按独立公式标记', () => {
  assert.match(markdownToHtml('如下 $$E=mc^2$$，可见'), /<span data-zb-tex data-zb-display>E=mc\^2<\/span>/);
});

test('金额等不成对的 $ 不当公式', () => {
  const html = markdownToHtml('价格 $5 和 $10');
  assert.ok(!html.includes('data-zb-tex'));
});

test('公式里的尖括号被转义', () => {
  assert.match(markdownToHtml('$a<b>c$'), /a&lt;b&gt;c/);
});

test('GFM 表格与任务列表', () => {
  const html = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] 完成\n- [ ] 待办');
  assert.match(html, /<table>/);
  assert.ok(html.includes('☑ ') && html.includes('☐ '));
});
