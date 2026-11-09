import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeHtml,
  inlineToPlainText,
  markdownToPlainText,
  parseInline,
  parseMarkdown,
  sanitizeHref
} from '../webview/src/chat/markdown.ts';

test('markdown: сырой HTML остаётся текстом и не становится разметкой', () => {
  const blocks = parseMarkdown('<script>alert("xss")</script>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, 'paragraph');

  const paragraph = blocks[0];
  assert.equal(paragraph.kind, 'paragraph');
  assert.ok(paragraph.children.every((node) => node.kind === 'text'));
  assert.equal(inlineToPlainText(paragraph.children), '<script>alert("xss")</script>');

  const img = parseMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(markdownToPlainText(img), '<img src=x onerror=alert(1)>');
});

test('markdown: ссылки — только http(s) и mailto, javascript/data отбрасываются', () => {
  assert.equal(sanitizeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(sanitizeHref('http://example.com'), 'http://example.com');
  assert.equal(sanitizeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(sanitizeHref('javascript:alert(1)'), null);
  assert.equal(sanitizeHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeHref('  '), null);

  const [node] = parseInline('[клик](javascript:alert(1))');
  assert.equal(node?.kind, 'link');
  assert.equal(node.href, null, 'опасная ссылка не получает href');

  const [safe] = parseInline('[сайт](https://example.com?q="x")');
  assert.equal(safe?.kind, 'link');
  assert.equal(safe.href, 'https://example.com?q="x"');
});

test('markdown: code fence сохраняет язык и текст как есть', () => {
  const blocks = parseMarkdown('```ts\nconst a = 1;\n```');
  assert.deepEqual(blocks, [
    { kind: 'code', language: 'ts', text: 'const a = 1;' }
  ]);

  const htmlInCode = parseMarkdown('```html\n<b>bold</b>\n```');
  assert.equal(htmlInCode[0]?.kind, 'code');
  assert.equal(htmlInCode[0]?.text, '<b>bold</b>');
});

test('markdown: заголовки, списки, цитаты и горизонтальная линия', () => {
  const blocks = parseMarkdown(
    ['# Заголовок', '', '- один', '- два', '', '1. первый', '2. второй', '', '> цитата', '', '---'].join('\n')
  );

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['heading', 'list', 'list', 'quote', 'rule']
  );
  assert.equal(blocks[0]?.kind === 'heading' ? blocks[0].level : 0, 1);
  assert.equal(blocks[1]?.kind === 'list' ? blocks[1].ordered : null, false);
  assert.equal(blocks[2]?.kind === 'list' ? blocks[2].ordered : null, true);
});

test('markdown: инлайн-разметка и экранирование', () => {
  const nodes = parseInline('**жирно** и *курсив* и `код`');
  assert.deepEqual(
    nodes.map((node) => node.kind),
    ['strong', 'text', 'em', 'text', 'code']
  );
  assert.equal(escapeHtml('<b>&"</b>'), '&lt;b&gt;&amp;&quot;&lt;/b&gt;');
});

test('markdown: незакрытые маркеры не ломают разбор', () => {
  const nodes = parseInline('**незакрытый ** и [без ссылки');
  const text = inlineToPlainText(nodes);
  assert.match(text, /незакрытый/);
  assert.match(text, /\[без ссылки/);
});
