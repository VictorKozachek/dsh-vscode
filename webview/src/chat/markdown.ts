/**
 * Безопасный разбор markdown для ленты чата.
 *
 * Модель принципиально не исполняет HTML: всё, что похоже на теги, остаётся
 * текстом (`kind: 'text'`), а рендер идёт React-элементами — никакого
 * `dangerouslySetInnerHTML`. Ссылки разрешены только `http(s):`/`mailto:`,
 * остальные (`javascript:`, `data:`) превращаются в текст.
 *
 * Модуль без импортов — покрыт тестами в Node (`tests/chat-markdown.test.mjs`).
 */

/** Узел инлайновой разметки. */
export type InlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'em'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'link'; readonly href: string | null; readonly children: readonly InlineNode[] };

/** Блок markdown. */
export type MarkdownBlock =
  | { readonly kind: 'paragraph'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'heading'; readonly level: number; readonly children: readonly InlineNode[] }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly InlineNode[])[] }
  | { readonly kind: 'quote'; readonly children: readonly InlineNode[] }
  | { readonly kind: 'rule' };

const FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+\.\s+(.*)$/;

/** Разбирает markdown в блоки. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const language = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && FENCE.exec(lines[index] ?? '') === null) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // закрывающий ```
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        children: parseInline(heading[2] ?? '')
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const quote = QUOTE.exec(lines[index] ?? '');
        if (quote === null) {
          break;
        }
        body.push(quote[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', children: parseInline(body.join(' ')) });
      continue;
    }

    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = isOrdered ? ORDERED_ITEM.exec(current) : UNORDERED_ITEM.exec(current);
        if (match === null) {
          break;
        }
        items.push(parseInline(match[1] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    // Абзац: всё до пустой строки или начала другого блока.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        QUOTE.test(current) ||
        UNORDERED_ITEM.test(current) ||
        ORDERED_ITEM.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

/** Разбирает инлайновую разметку; HTML тегами не считается. */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = '';
  let index = 0;

  const flushText = (): void => {
    if (buffer !== '') {
      nodes.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  while (index < source.length) {
    const character = source[index];

    if (character === '`') {
      const end = source.indexOf('`', index + 1);
      if (end < 0) {
        buffer += character;
        index += 1;
        continue;
      }
      flushText();
      nodes.push({ kind: 'code', text: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    if (character === '*' && source[index + 1] === '*') {
      const end = source.indexOf('**', index + 2);
      if (end < 0) {
        buffer += '**';
        index += 2;
        continue;
      }
      flushText();
      nodes.push({ kind: 'strong', children: parseInline(source.slice(index + 2, end)) });
      index = end + 2;
      continue;
    }

    if (character === '*' || character === '_') {
      const end = source.indexOf(character, index + 1);
      if (end < 0) {
        buffer += character;
        index += 1;
        continue;
      }
      flushText();
      nodes.push({ kind: 'em', children: parseInline(source.slice(index + 1, end)) });
      index = end + 1;
      continue;
    }

    if (character === '[') {
      const close = source.indexOf(']', index + 1);
      const open = close >= 0 ? source.indexOf('(', close + 1) : -1;
      const closeParen = open >= 0 ? source.indexOf(')', open + 1) : -1;
      if (close > 0 && open === close + 1 && closeParen > open) {
        flushText();
        const label = source.slice(index + 1, close);
        const href = sanitizeHref(source.slice(open + 1, closeParen));
        nodes.push({ kind: 'link', href, children: parseInline(label) });
        index = closeParen + 1;
        continue;
      }
    }

    buffer += character;
    index += 1;
  }

  flushText();
  return nodes;
}

/** Разрешённые схемы ссылок: всё остальное — не ссылка. */
export function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
    return trimmed;
  }
  return null;
}

/** Экранирует HTML-спецсимволы (для отладочного/текстового вывода). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Плоский текст из блоков — для копирования и тестов. */
export function markdownToPlainText(blocks: readonly MarkdownBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'paragraph':
        case 'heading':
        case 'quote':
          return inlineToPlainText(block.children);
        case 'code':
          return block.text;
        case 'list':
          return block.items.map((item) => inlineToPlainText(item)).join('\n');
        case 'rule':
          return '---';
      }
    })
    .join('\n\n');
}

/** Плоский текст из инлайновых узлов. */
export function inlineToPlainText(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text;
        case 'strong':
        case 'em':
          return inlineToPlainText(node.children);
        case 'link':
          return inlineToPlainText(node.children);
      }
    })
    .join('');
}
