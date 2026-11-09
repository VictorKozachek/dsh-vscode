import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { parseMarkdown } from './markdown';
import type { InlineNode, MarkdownBlock } from './markdown';

export interface MarkdownViewProps {
  readonly text: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
}

/**
 * Рендер markdown безопасными React-элементами: HTML из ответа агента никогда
 * не вставляется как разметка (нет `dangerouslySetInnerHTML`), ссылки проходят
 * `sanitizeHref`, code-блоки получают кнопку «копировать».
 */
export function MarkdownView({ text, copyLabel, copiedLabel }: MarkdownViewProps): ReactElement {
  const blocks = parseMarkdown(text);
  return <div className="dsh-markdown">{blocks.map((block, index) => renderBlock(block, index, copyLabel, copiedLabel))}</div>;
}

function renderBlock(
  block: MarkdownBlock,
  key: number,
  copyLabel: string,
  copiedLabel: string
): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.children)}</p>;
    case 'heading': {
      const Tag = (`h${Math.min(6, Math.max(1, block.level))}` as const) as 'h1';
      return <Tag key={key}>{renderInline(block.children)}</Tag>;
    }
    case 'code':
      return <CodeBlock key={key} language={block.language} text={block.text} copyLabel={copyLabel} copiedLabel={copiedLabel} />;
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{renderInline(item)}</li>);
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case 'quote':
      return <blockquote key={key}>{renderInline(block.children)}</blockquote>;
    case 'rule':
      return <hr key={key} />;
  }
}

function renderInline(nodes: readonly InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>;
      case 'link':
        return node.href === null ? (
          <span key={index}>{renderInline(node.children)}</span>
        ) : (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

interface CodeBlockProps {
  readonly language: string;
  readonly text: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
}

function CodeBlock({ language, text, copyLabel, copiedLabel }: CodeBlockProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className="dsh-code">
      <div className="dsh-code__bar">
        <span className="dsh-code__language">{language === '' ? 'code' : language}</span>
        <button type="button" className="dsh-button dsh-button--ghost" onClick={copy}>
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="dsh-code__body">
        <code>{text}</code>
      </pre>
    </div>
  );
}
