import { useState } from 'react';
import { ArrowUpRight, FileText, Search, ShieldAlert } from 'lucide-react';
import type { SearchLink, SearchResult } from '../../shared/types';
import { plural } from '../plural';
import type { ToolPart } from './ToolChip';

const RESEARCH = new Set(['search_obd_memorial', 'read_obd_record', 'prepare_search_links']);
const LABEL: Record<string, string> = { search_obd_memorial: 'ОБД «Мемориал»', read_obd_record: 'карточке ОБД', prepare_search_links: 'ссылки для поиска' };

export function isResearchPart(part: ToolPart): boolean {
  return RESEARCH.has(part.type.slice(5));
}

export function ResearchCard({ part }: { part: ToolPart }) {
  const name = part.type.slice(5);
  if (part.state === 'output-error') {
    return <div className="research-card error"><ShieldAlert aria-hidden />{part.errorText}</div>;
  }
  if (part.state !== 'output-available') {
    return (
      <div className="research-card pending">
        <span className="spinner" aria-hidden />
        <span>{name === 'prepare_search_links' ? 'Готовлю ссылки…' : name === 'read_obd_record' ? 'Читаю карточку записи…' : `Ищу в ${LABEL[name]}…`}</span>
      </div>
    );
  }
  const output = part.output as unknown as (SearchResult & { blocked?: boolean; message?: string; links?: SearchLink[] }) | { links: SearchLink[] };
  if ('shown' in output) return <ResultList result={output} />;
  if ('fields' in output) return <RecordCard record={output as unknown as { url: string; source: string; fields: Record<string, string> }} />;
  return <LinkList links={output.links ?? []} message={'message' in output ? String(output.message ?? '') || undefined : undefined} />;
}

function ResultList({ result }: { result: SearchResult }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? result.shown : result.shown.slice(0, 4);
  return (
    <div className="research-card">
      <header>
        <Search aria-hidden />
        <div>
          <strong>{result.source}</strong>
          <small>{result.query} · {plural(result.total, ['запись', 'записи', 'записей'])}</small>
        </div>
        <a className="open-link" href={result.searchUrl} target="_blank" rel="noreferrer">На сайте <ArrowUpRight aria-hidden /></a>
      </header>
      {result.shown.length === 0 ? <p className="research-empty">Подходящих записей нет.</p> : (
        <ol className="findings-list">
          {visible.map(item => (
            <li key={item.url}>
              <a href={item.url} target="_blank" rel="noreferrer">
                <span className="finding-main">
                  <b>{item.name}</b>
                  {item.birth && <span className="year">{item.birth}</span>}
                </span>
                <span className="finding-meta">{[item.event, item.place].filter(Boolean).join(' · ')}</span>
                {item.kind && <span className="finding-kind">{item.kind}</span>}
              </a>
            </li>
          ))}
        </ol>
      )}
      {result.shown.length > 4 && (
        <button className="more" onClick={() => setExpanded(value => !value)}>
          {expanded ? 'Свернуть' : `Ещё ${result.shown.length - 4}`}
        </button>
      )}
      {result.note && <p className="research-note">{result.note}</p>}
    </div>
  );
}

/** Shown in the header or folded into «Архив»; everything else is listed as the site labels it. */
const HIDDEN_FIELDS = new Set(['Фамилия', 'Имя', 'Отчество', 'Название источника донесения', 'Номер фонда источника информации', 'Номер описи источника информации', 'Номер дела источника информации']);

function RecordCard({ record }: { record: { url: string; source: string; fields: Record<string, string> } }) {
  const f = record.fields;
  const name = [f['Фамилия'], f['Имя'], f['Отчество']].filter(Boolean).join(' ');
  const archive = [f['Название источника донесения'], f['Номер фонда источника информации'] && `ф. ${f['Номер фонда источника информации']}`, f['Номер описи источника информации'] && `оп. ${f['Номер описи источника информации']}`, f['Номер дела источника информации'] && `д. ${f['Номер дела источника информации']}`].filter(Boolean).join(', ');
  return (
    <div className="research-card record">
      <header>
        <FileText aria-hidden />
        <div><strong>{name || 'Запись'}</strong><small>{record.source}</small></div>
        <a className="open-link" href={record.url} target="_blank" rel="noreferrer">Открыть <ArrowUpRight aria-hidden /></a>
      </header>
      <dl className="record-fields">
        {Object.keys(f).filter(key => !HIDDEN_FIELDS.has(key)).map(key => <div key={key}><dt>{key.replace('/Возраст', '')}</dt><dd>{f[key]}</dd></div>)}
        {archive && <div><dt>Архив</dt><dd>{archive}</dd></div>}
      </dl>
    </div>
  );
}

function LinkList({ links, message }: { links: SearchLink[]; message?: string }) {
  return (
    <div className="research-card">
      {message && <p className="research-note warn">{message}</p>}
      <ul className="link-list">
        {links.map(link => (
          <li key={link.url}>
            <a href={link.url} target="_blank" rel="noreferrer">
              <span><b>{link.source}</b><small>{link.label}{link.note ? ` · ${link.note}` : ''}</small></span>
              <ArrowUpRight aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
