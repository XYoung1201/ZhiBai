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

test('中文标点旁的加粗、斜体、删除线（CommonMark 定界规则失效的情形）', () => {
  assert.equal(markdownToHtml('这是：**这需要加粗**。').trim(), '<p>这是：<strong>这需要加粗</strong>。</p>');
  assert.match(markdownToHtml('**加粗：**后文'), /<strong>加粗：<\/strong>后文/);
  assert.match(markdownToHtml('中文**“引号”**中文'), /中文<strong>“引号”<\/strong>中文/);
  assert.match(markdownToHtml('**（括号）**里'), /<strong>（括号）<\/strong>里/);
  assert.match(markdownToHtml('*斜体：*后'), /<em>斜体：<\/em>后/);
  assert.match(markdownToHtml('前~~删除：~~后'), /前<del>删除：<\/del>后/);
  assert.match(markdownToHtml('__中文下划__线'), /<strong>中文下划<\/strong>线/);
  assert.match(markdownToHtml('***粗斜***'), /<strong><em>粗斜<\/em><\/strong>/);
  assert.match(markdownToHtml('**粗 *斜* 粗**'), /<strong>粗 <em>斜<\/em> 粗<\/strong>/);
});

test('==高亮==', () => {
  assert.match(markdownToHtml('==高亮==文字'), /<mark>高亮<\/mark>文字/);
  assert.ok(!markdownToHtml('a == b == c').includes('<mark>'));
});

test('放宽规则不误伤代码、公式、转义与英文下划线', () => {
  assert.match(markdownToHtml('`**不是**`代码'), /<code>\*\*不是\*\*<\/code>/);
  assert.match(markdownToHtml('**含 `a**b` 代码**'), /<strong>含 <code>a\*\*b<\/code> 代码<\/strong>/);
  assert.match(markdownToHtml('**a $x**2$ b**'), /<strong>a <span data-zb-tex>x\*\*2<\/span> b<\/strong>/);
  assert.equal(markdownToHtml('\\*\\*转义\\*\\*').trim(), '<p>**转义**</p>');
  assert.ok(!markdownToHtml('snake_case_name').includes('<em>'));
  assert.ok(!markdownToHtml('2 * 3 * 4').includes('<em>'));
  assert.ok(!markdownToHtml('** 空格 **').includes('<strong>'));
});
