import { Fragment, type ReactNode } from 'react';

/** Just enough markdown for chat replies: paragraphs, lists, bold. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n');
        if (lines.every(line => /^\s*[-*•]\s+/.test(line))) {
          return <ul key={index}>{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*[-*•]\s+/, ''))}</li>)}</ul>;
        }
        if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) {
          return <ol key={index}>{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>)}</ol>;
        }
        return (
          <p key={index}>
            {lines.map((line, i) => <Fragment key={i}>{i > 0 && <br />}{inline(line.replace(/^#+\s*/, ''))}</Fragment>)}
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
