import { Fragment, type ReactNode } from 'react';

type Block = { kind: 'p' | 'ul' | 'ol'; lines: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;

/** Just enough markdown for chat replies: paragraphs, lists, bold. */
export function Markdown({ text }: { text: string }) {
  const blocks: Block[] = [];
  for (const line of text.trim().split('\n')) {
    const kind = BULLET.test(line) ? 'ul' : NUMBER.test(line) ? 'ol' : line.trim() ? 'p' : null;
    const last = blocks.at(-1);
    if (kind === null) { blocks.push({ kind: 'p', lines: [] }); continue; }
    if (last && last.kind === kind && (kind !== 'p' || last.lines.length > 0)) last.lines.push(line);
    else blocks.push({ kind, lines: [line] });
  }
  return (
    <>
      {blocks.filter(block => block.lines.length > 0).map((block, index) => {
        if (block.kind === 'ul') return <ul key={index}>{block.lines.map((line, i) => <li key={i}>{inline(line.replace(BULLET, ''))}</li>)}</ul>;
        if (block.kind === 'ol') return <ol key={index}>{block.lines.map((line, i) => <li key={i}>{inline(line.replace(NUMBER, ''))}</li>)}</ol>;
        return (
          <p key={index}>
            {block.lines.map((line, i) => <Fragment key={i}>{i > 0 && <br />}{inline(line.replace(/^#+\s*/, ''))}</Fragment>)}
          </p>
        );
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}
