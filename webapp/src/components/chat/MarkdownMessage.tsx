import { Fragment } from 'react';

function renderInline(text: string) {
  const pattern = /(`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)]+)\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const parts = text.split(pattern).filter(Boolean);

  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('[')) {
      const match = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      if (match) {
        return (
          <a key={index} href={match[2]} target="_blank" rel="noreferrer">
            {match[1]}
          </a>
        );
      }
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export default function MarkdownMessage({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: Array<{ type: string; lines?: string[]; text?: string; level?: number }> = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: 'list', lines: list });
      list = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ type: 'quote', lines: quote });
      quote = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      flushQuote();
      if (inCode) {
        blocks.push({ type: 'code', lines: code });
        code = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      flushQuote();
      list.push(listItem[1]);
      continue;
    }
    const quoteItem = line.match(/^>\s?(.*)$/);
    if (quoteItem) {
      flushParagraph();
      flushList();
      quote.push(quoteItem[1]);
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  if (code.length) blocks.push({ type: 'code', lines: code });

  return (
    <div className="markdown-body">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          if (block.level === 1) return <h1 key={index}>{renderInline(block.text || '')}</h1>;
          if (block.level === 2) return <h2 key={index}>{renderInline(block.text || '')}</h2>;
          return <h3 key={index}>{renderInline(block.text || '')}</h3>;
        }
        if (block.type === 'list') {
          return (
            <ul key={index}>
              {(block.lines || []).map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}
            </ul>
          );
        }
        if (block.type === 'quote') {
          return <blockquote key={index}>{(block.lines || []).join('\n')}</blockquote>;
        }
        if (block.type === 'code') {
          return <pre key={index}><code>{(block.lines || []).join('\n')}</code></pre>;
        }
        return <p key={index}>{renderInline((block.lines || []).join(' '))}</p>;
      })}
    </div>
  );
}
