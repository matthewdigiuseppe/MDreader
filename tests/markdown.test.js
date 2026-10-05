// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const MD = require('../js/markdown.js');

const render = (src) => MD.renderDocument(src);

test('splitBlocks keeps fences, math and lists together', () => {
  const doc = '# T\n\npara one\nline two\n\n```js\na\n\nb\n```\n\n$$\nx\n\ny\n$$\n\n- a\n- b\n';
  assert.deepEqual(MD.splitBlocks(doc), ['# T', 'para one\nline two', '```js\na\n\nb\n```', '$$\nx\n\ny\n$$', '- a\n- b']);
});

test('splitBlocks separates headings from following text', () => {
  assert.deepEqual(MD.splitBlocks('# A\ntext\n## B'), ['# A', 'text', '## B']);
});

test('front matter becomes the first block', () => {
  const blocks = MD.splitBlocks('---\ntitle: X\n---\n\nBody');
  assert.equal(blocks[0], '---\ntitle: X\n---');
  assert.match(render('---\ntitle: X\n---\n\nBody'), /<div class="front-matter">.*<th>title<\/th><td>X<\/td>/);
});

test('inline formatting', () => {
  const html = MD.inline('**b** *i* _i2_ ~~s~~ ==m== `c_x` H~2~O x^2^ snake_case_word');
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<em>i<\/em>/);
  assert.match(html, /<em>i2<\/em>/);
  assert.match(html, /<del>s<\/del>/);
  assert.match(html, /<mark>m<\/mark>/);
  assert.match(html, /<code>c_x<\/code>/);
  assert.match(html, /H<sub>2<\/sub>O/);
  assert.match(html, /x<sup>2<\/sup>/);
  assert.match(html, /snake_case_word/);
});

test('links, images and autolinks', () => {
  const html = MD.inline('[a *b*](http://x.com/a_b "T") ![alt](img.png) https://e.com/p_q.');
  assert.match(html, /<a href="http:\/\/x.com\/a_b" title="T">a <em>b<\/em><\/a>/);
  assert.match(html, /<img src="img.png" alt="alt"/);
  assert.match(html, /<a href="https:\/\/e.com\/p_q">https:\/\/e.com\/p_q<\/a>\./);
});

test('unsafe urls are neutralised and html is escaped', () => {
  const html = MD.inline('[x](javascript:alert(1)) <script>bad()</script> <sub>ok</sub>');
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<sub>ok<\/sub>/);
});

test('inline math does not eat currency', () => {
  assert.match(MD.inline('$x_1$'), /class="math-inline" data-tex="x_1"/);
  assert.doesNotMatch(MD.inline('costs $5 and $10'), /math-inline/);
});

test('citations and footnotes', () => {
  const html = render('See [@smith2020, p. 4; @doe] and a note[^n].\n\n[^n]: Footnote text.');
  assert.match(html, /<span class="cite" data-keys="smith2020,doe">/);
  assert.match(html, /<sup class="fn-ref"><a href="#fn-n" title="Footnote text.">1<\/a><\/sup>/);
  assert.match(html, /<div class="footnote-def" id="fn-n">/);
  assert.doesNotMatch(MD.inline('[mail me@example.com]'), /cite/);
});

test('nested and task lists', () => {
  const html = render('- a\n  - b\n- [x] done\n- [ ] todo');
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li class="task done"><input type="checkbox" class="task-box" checked> done<\/li><li class="task">/);
  assert.match(render('3. x\n4. y'), /<ol start="3"><li>x<\/li><li>y<\/li><\/ol>/);
});

test('tables with alignment and escaped pipes', () => {
  const html = render('| a | b |\n|:-:|--:|\n| `x|y` | 2 |');
  assert.match(html, /<th style="text-align:center">a<\/th>/);
  assert.match(html, /<td style="text-align:center"><code>x\|y<\/code><\/td>/);
});

test('code blocks escape html and keep language', () => {
  const html = render('```python\nif a < b: pass\n```');
  assert.match(html, /<code class="language-python">if a &lt; b: pass<\/code>/);
});

test('display math', () => {
  assert.match(render('$$\n\\frac{a}{b}\n$$'), /<div class="math-block" data-tex="\\frac\{a\}\{b\}">/);
  assert.match(render('$$ E=mc^2 $$'), /data-tex="E=mc\^2"/);
});

test('callouts and blockquotes', () => {
  assert.match(render('> [!WARNING] Careful\n> body'), /<div class="callout callout-warning"><div class="callout-title">Careful<\/div><p>body<\/p><\/div>/);
  assert.match(render('> a\n> b'), /<blockquote><p>a\nb<\/p><\/blockquote>/);
});

test('round trip: joining blocks preserves content', () => {
  const doc = '# A\n\ntext\n\n- x\n- y\n\n```\ncode\n```';
  assert.equal(MD.splitBlocks(doc).join('\n\n'), doc);
});
