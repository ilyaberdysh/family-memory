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
        if (block.kind === 'ol') return <ol key={index} start={Number(block.lines[0].match(/\d+/)?.[0] ?? 1)}>{block.lines.map((line, i) => <li key={i}>{inline(line.replace(NUMBER, ''))}</li>)}</ol>;
        return (
          <p key={index}>
            {block.lines.map((line, i) => <Fragment key={i}>{i > 0 && <br />}{inline(line.replace(/^#+\s*/, ''))}</Fragment>)}
          </p>
        );
      })}
    </>
  );
}

const TOKEN = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g;

function inline(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const labelled = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (labelled) return <a key={i} href={labelled[2]} target="_blank" rel="noreferrer">{labelled[1]}</a>;
    if (/^https?:\/\//.test(part)) {
      const url = part.replace(/[.,;:]+$/, '');
      return <a key={i} href={url} target="_blank" rel="noreferrer">{hostOf(url)}</a>;
    }
    return part;
  });
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
