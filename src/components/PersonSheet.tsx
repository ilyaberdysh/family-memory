import { Trash2, X } from 'lucide-react';
import { PROVENANCE_LABEL, type Person, type TreeState } from '../../shared/types';
import { lifespan } from '../tree-layout';

type Props = {
  person: Person;
  tree: TreeState;
  onSelect: (id: string) => void;
  onClose: () => void;
  onDelete: () => void;
};

export function PersonSheet({ person, tree, onSelect, onClose, onDelete }: Props) {
  const byId = (id: string) => tree.people.find(p => p.id === id);
  const parents = tree.relations.filter(r => r.type === 'parent' && r.toId === person.id).map(r => byId(r.fromId));
  const children = tree.relations.filter(r => r.type === 'parent' && r.fromId === person.id).map(r => byId(r.toId));
  const spouses = tree.relations.filter(r => r.type === 'spouse' && (r.fromId === person.id || r.toId === person.id))
    .map(r => byId(r.fromId === person.id ? r.toId : r.fromId));

  const group = (title: string, people: (Person | undefined)[]) => {
    const list = people.filter((p): p is Person => Boolean(p));
    if (list.length === 0) return null;
    return (
      <div className="sheet-group">
        <h3>{title}</h3>
        {list.map(p => <button key={p.id} className="sheet-link" onClick={() => onSelect(p.id)}>{p.name}</button>)}
      </div>
    );
  };

  const life = lifespan(person);
  return (
    <aside className="sheet" aria-label={person.name}>
      <header className="sheet-head">
        <span className="badge" data-provenance={person.provenance}>{PROVENANCE_LABEL[person.provenance]}</span>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть"><X aria-hidden /></button>
      </header>
      <h2>{person.name}</h2>
      {(life || person.birth?.place || person.death?.place) && (
        <dl className="facts">
          {person.birth && <><dt>Рождение</dt><dd>{[person.birth.year && `${person.birth.approximate ? 'около ' : ''}${person.birth.year}`, person.birth.place].filter(Boolean).join(', ')}</dd></>}
          {person.death && <><dt>Смерть</dt><dd>{[person.death.year && `${person.death.approximate ? 'около ' : ''}${person.death.year}`, person.death.place].filter(Boolean).join(', ')}</dd></>}
        </dl>
      )}
      {person.note && <p className="sheet-note">{person.note}</p>}
      {person.source && (
        <p className="sheet-source">
          Источник: {/^https?:\/\//.test(person.source)
            ? <a href={person.source} target="_blank" rel="noreferrer">{sourceLabel(person.source)} ↗</a>
            : person.source}
        </p>
      )}
      {group('Родители', parents)}
      {group('Супруги', spouses)}
      {group('Дети', children)}
      <button className="danger-link" onClick={() => { if (confirm(`Убрать «${person.name}» из древа? Это можно отменить.`)) onDelete(); }}>
        <Trash2 aria-hidden />Убрать из древа
      </button>
    </aside>
  );
}

function sourceLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'obd-memorial.ru' ? 'запись в ОБД «Мемориал»' : host;
  } catch {
    return url;
  }
}
