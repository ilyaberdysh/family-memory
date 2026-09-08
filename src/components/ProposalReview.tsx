import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { FACT_LABELS, type AppState, type FactKey, type Material, type NameParts, type Person, type Proposal } from '../../shared/types';
import { EMPTY_NAME_PARTS, fullName, formatFamilyDate, isDateFact } from '../../shared/person-fields';
import { resolveProposal, validateProposal } from '../proposal-review';
import { api, json } from '../api';
import { FamilyDateField, NamePartsFields } from './PeopleForms';

type Decision = 'keep' | 'accept' | 'reject';
type Issue = ReturnType<typeof validateProposal>[number];
type Props = { material: Material; state: AppState; canReview: boolean; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; onSaved: (material: Material) => Promise<void>; onSeek: (time: number) => void };
const proposedName = (proposal: Proposal) => proposal.nameParts ? fullName(proposal.nameParts) : proposal.personName || proposal.value || '';
const normalized = (name: string) => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export default function ProposalReview({ material, state, canReview, onDirtyChange, onBusyChange, onSaved, onSeek }: Props) {
  const initial = () => (material.proposals || []).filter(item => item.status === 'pending').map(item => resolveProposal(item, state.people, state.facts));
  const [proposals, setProposals] = useState(initial);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [issues, setIssues] = useState<Record<string, Issue[]>>({});
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = useRef<Record<string, HTMLElement | null>>({});
  const selected = Object.values(decisions).filter(value => value !== 'keep').length;
  const dirty = edited || selected > 0;
  const newNamesFor = (items: Proposal[], choices: Record<string, Decision>) => items.filter(item => item.action === 'create_person' && !item.personId && choices[item.id] === 'accept').map(proposedName).filter(Boolean);
  const newNames = newNamesFor(proposals, decisions);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  function reveal(id: string) {
    setEditing(previous => ({ ...previous, [id]: true }));
    requestAnimationFrame(() => {
      const row = rows.current[id];
      row?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      row?.querySelector<HTMLElement>('[data-field-error="true"] select, [data-field-error="true"] input, [data-field-error="true"] textarea')?.focus({ preventScroll: true });
    });
  }
  function patch(id: string, change: Partial<Proposal>) {
    const next = proposals.map(item => item.id === id ? { ...item, ...change } : item);
    setEdited(true); setProposals(next); setError('');
    if (issues[id]?.length) setIssues(previous => ({ ...previous, [id]: validateProposal(next.find(item => item.id === id)!, state.people, newNamesFor(next, decisions)) }));
  }
  function choose(proposal: Proposal, decision: Decision) {
    const next = { ...decisions, [proposal.id]: decision };
    setDecisions(next); setError('');
    const nextIssues = decision === 'accept' ? validateProposal(proposal, state.people, newNamesFor(proposals, next)) : [];
    setIssues(previous => ({ ...previous, [proposal.id]: nextIssues }));
    if (nextIssues.length) reveal(proposal.id);
  }
  async function save() {
    if (busy || !selected) return;
    setError('');
    const accepted = proposals.filter(item => decisions[item.id] === 'accept');
    const nextIssues = Object.fromEntries(accepted.map(item => [item.id, validateProposal(item, state.people, newNames)]));
    setIssues(nextIssues);
    const invalid = accepted.filter(item => nextIssues[item.id].length);
    if (invalid.length) {
      setEditing(previous => ({ ...previous, ...Object.fromEntries(invalid.map(item => [item.id, true])) }));
      setError('Уточните отмеченные поля перед сохранением.'); reveal(invalid[0].id); return;
    }
    setBusy(true);
    try {
      const next = await api<Material>(`/api/materials/${material.id}/proposals`, json('POST', { accept: accepted, reject: proposals.filter(item => decisions[item.id] === 'reject').map(item => item.id), transcriptVersion: material.transcript?.version ?? null }));
      setEdited(false); setDecisions({}); onDirtyChange(false); await onSaved(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить решения. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  }
  function reset() { setProposals(initial()); setDecisions({}); setEditing({}); setIssues({}); setEdited(false); setError(''); }

  return <div className="archive-proposals">
    {!canReview && <p className="muted">Предложения может принять автор материала или администратор.</p>}
    <div className="archive-proposal-list">{proposals.map(proposal => {
      const decision = decisions[proposal.id] || 'keep';
      const current = proposal.action === 'set_fact' ? state.facts.find(fact => fact.personId === proposal.personId && fact.key === proposal.key) : undefined;
      const issue = (field: Issue['field']) => issues[proposal.id]?.find(item => item.field === field)?.message;
      const person = state.people.find(item => item.id === proposal.personId)?.name || proposal.personName || 'Человек не выбран';
      const value = proposal.key === 'name' && proposal.nameParts ? fullName(proposal.nameParts) : proposal.value || 'Значение не указано';
      const showValue = (value: string) => proposal.key && isDateFact(proposal.key) ? formatFamilyDate(value) : value;
      return <article key={proposal.id} ref={element => { rows.current[proposal.id] = element; }} className={`archive-proposal ${decision === 'accept' ? 'will-accept' : decision === 'reject' ? 'will-reject' : ''} ${issues[proposal.id]?.length ? 'has-errors' : ''}`} aria-label={proposal.action === 'create_relation' ? 'Предложение о связи' : `Предложение: ${person}`}>
        <div className="archive-proposal-summary">
          <p className="archive-proposal-kind">{proposal.action === 'create_person' ? proposal.personId ? 'Человек уже в дереве' : 'Новый человек' : proposal.action === 'create_relation' ? proposal.relationType === 'partner' ? 'Партнёры' : 'Родственная связь' : proposal.action === 'link_material' ? 'Связать с этой историей' : proposal.key ? FACT_LABELS[proposal.key] : 'Сведение'}</p>
          {proposal.action === 'create_relation' ? <div className="archive-relation-summary"><div><span>{proposal.relationType === 'partner' ? 'Первый человек' : 'Родитель'}</span><strong>{state.people.find(item => item.id === proposal.fromId)?.name || proposal.fromName || 'Не выбран'}</strong></div><span className="archive-relation-arrow" aria-hidden="true">{proposal.relationType === 'partner' ? '↔' : '→'}</span><div><span>{proposal.relationType === 'partner' ? 'Второй человек' : 'Ребёнок'}</span><strong>{state.people.find(item => item.id === proposal.toId)?.name || proposal.toName || 'Не выбран'}</strong></div></div> : <>
            <h4>{proposal.action === 'create_person' ? proposal.personId ? person : proposedName(proposal) || 'Имя не указано' : person}</h4>
            {proposal.action === 'set_fact' && <div className="archive-proposal-value">{current && current.value !== value && <><span className="archive-previous-value"><span className="sr-only">Сейчас: </span>{showValue(current.value)}</span><span aria-hidden="true"> → </span></>}<span><span className="sr-only">Предлагается: </span>{showValue(value)}</span></div>}
          </>}
        </div>
        {canReview && <div className="archive-proposal-actions">
          <div className="archive-decision-buttons"><button className={`button ${decision === 'accept' ? 'primary' : 'secondary'}`} aria-pressed={decision === 'accept'} disabled={busy} onClick={() => choose(proposal, decision === 'accept' ? 'keep' : 'accept')}><Check size={16} />Принять</button><button className={`button secondary ${decision === 'reject' ? 'selected-reject' : ''}`} aria-pressed={decision === 'reject'} disabled={busy} onClick={() => choose(proposal, decision === 'reject' ? 'keep' : 'reject')}><X size={16} />Отклонить</button></div>
          {decision !== 'keep' && <button className="archive-text-button archive-cancel-decision" disabled={busy} onClick={() => choose(proposal, 'keep')}>Отменить решение</button>}
          <button className="archive-text-button archive-edit-proposal" disabled={busy} aria-expanded={!!editing[proposal.id]} onClick={() => setEditing(previous => ({ ...previous, [proposal.id]: !previous[proposal.id] }))}><Pencil size={15} />{editing[proposal.id] ? 'Скрыть поля' : 'Исправить'}</button>
        </div>}
        {decision !== 'keep' && <p className="archive-staged-decision">{decision === 'accept' ? 'К принятию' : 'К отклонению'} · ещё не сохранено</p>}
        {editing[proposal.id] && <fieldset className="archive-proposal-editor" disabled={!canReview || busy || decision === 'reject'}>
          {proposal.action === 'create_person' ? <>
            <label className="field">Кого добавить<select value={proposal.personId || ''} onChange={event => patch(proposal.id, { personId: event.target.value || null })}><option value="">Создать нового человека</option>{state.people.map(person => <option key={person.id} value={person.id}>{person.name} · уже в дереве</option>)}</select></label>
            {!proposal.personId && <div data-field-error={!!issue('personName')}><ProposalNameFields value={proposedName(proposal)} originalValue={material.proposals?.find(item => item.id === proposal.id)?.personName || ''} nameParts={proposal.nameParts} onChange={(value, nameParts) => patch(proposal.id, { personName: value, value, nameParts })} /><FieldError text={issue('personName')} /></div>}
          </> : proposal.action === 'create_relation' ? <>
            <div className="form-grid"><PersonResolution label={proposal.relationType === 'partner' ? 'Первый человек' : 'Родитель'} id={proposal.fromId} name={proposal.fromName} people={state.people} newNames={newNames} error={issue('fromId')} fieldId={`${proposal.id}-from`} onChange={(id, name) => patch(proposal.id, { fromId: id, fromName: name })} /><PersonResolution label={proposal.relationType === 'partner' ? 'Второй человек' : 'Ребёнок'} id={proposal.toId} name={proposal.toName} people={state.people} newNames={newNames} error={issue('toId')} fieldId={`${proposal.id}-to`} onChange={(id, name) => patch(proposal.id, { toId: id, toName: name })} /></div>
            <div className="form-grid"><label className="field">Связь<select value={proposal.relationType || 'parent'} onChange={event => patch(proposal.id, { relationType: event.target.value as 'parent' | 'partner' })}><option value="parent">Родитель → ребёнок</option><option value="partner">Партнёры</option></select></label>{proposal.relationType !== 'partner' && <label className="field">Родительство<select value={proposal.parentKind || 'unspecified'} onChange={event => patch(proposal.id, { parentKind: event.target.value as Proposal['parentKind'] })}><option value="unspecified">Не уточнено</option><option value="biological">Биологическое</option><option value="adoptive">Усыновление</option></select></label>}</div>
          </> : <>
            <PersonResolution label="Человек" id={proposal.personId} name={proposal.personName} people={state.people} newNames={newNames} error={issue('personId')} fieldId={`${proposal.id}-person`} onChange={(id, name) => patch(proposal.id, { personId: id, personName: name, baseVersion: state.facts.find(fact => fact.personId === id && fact.key === proposal.key)?.version ?? null })} />
            {proposal.action === 'set_fact' && <>
              <label className="field" data-field-error={!!issue('key')}>Сведение<select aria-invalid={!!issue('key')} value={proposal.key || ''} onChange={event => { const key = event.target.value as FactKey; patch(proposal.id, { key, nameParts: undefined, baseVersion: state.facts.find(fact => fact.personId === proposal.personId && fact.key === key)?.version ?? null }); }}><option value="">Выберите сведение</option>{Object.entries(FACT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><FieldError text={issue('key')} /></label>
              <div data-field-error={!!issue('value')}>{proposal.key === 'name' ? <ProposalNameFields value={proposal.value || ''} originalValue={material.proposals?.find(item => item.id === proposal.id)?.value || ''} nameParts={proposal.nameParts} onChange={(value, nameParts) => patch(proposal.id, { value, nameParts })} /> : proposal.key && isDateFact(proposal.key) ? <FamilyDateField label={FACT_LABELS[proposal.key]} value={formatFamilyDate(proposal.value || '')} onChange={value => patch(proposal.id, { value })} /> : <label className="field">Предлагаемое значение<textarea aria-invalid={!!issue('value')} rows={2} value={proposal.value || ''} onChange={event => patch(proposal.id, { value: event.target.value })} /></label>}<FieldError text={issue('value')} /></div>
            </>}
          </>}
        </fieldset>}
        <details className="archive-proposal-source"><summary>Источник</summary><blockquote>{proposal.sourceQuote}</blockquote>{proposal.sourceStart !== null && material.file && (material.kind === 'audio' || material.kind === 'video') && <button className="archive-timestamp" onClick={() => onSeek(proposal.sourceStart!)}>Послушать с {timeLabel(proposal.sourceStart)}</button>}</details>
      </article>;
    })}</div>
    {error && <div className="archive-error" role="alert">{error}</div>}
    {canReview && <div className="archive-proposal-footer"><p>{selected ? `Выбрано ${selected} из ${proposals.length}. Остальные можно рассмотреть позже.` : 'Выберите предложения, с которыми согласны.'}</p><div className="archive-inline-actions"><button className="archive-text-button" disabled={busy || !dirty} onClick={reset}>Сбросить</button><button className="button primary" disabled={busy || !selected} onClick={() => void save()}>{busy ? 'Сохраняем…' : `Сохранить решения${selected ? ` · ${selected}` : ''}`}</button></div></div>}
  </div>;
}

function FieldError({ text }: { text?: string }) { return text ? <span className="archive-field-error" role="alert">{text}</span> : null; }
function ProposalNameFields({ value, originalValue, nameParts, onChange }: { value: string; originalValue: string; nameParts?: NameParts; onChange: (value: string, nameParts?: NameParts) => void }) {
  return <>{!nameParts && value && <p className="form-hint">В источнике: «{value}». Запись сохранится, пока вы не уточните части ФИО.</p>}<NamePartsFields value={nameParts || EMPTY_NAME_PARTS} onChange={parts => onChange(fullName(parts), parts)} />{nameParts && originalValue && <button type="button" className="archive-text-button" onClick={() => onChange(originalValue, undefined)}>Оставить имя как в источнике: {originalValue}</button>}<p className="form-hint">Неизвестные части имени можно оставить пустыми.</p></>;
}
function PersonResolution({ label, id, name, people, newNames, error, fieldId, onChange }: { label: string; id: string | null; name: string | null; people: Person[]; newNames: string[]; error?: string; fieldId: string; onChange: (id: string | null, name: string | null) => void }) {
  const resolvedName = !id && name ? newNames.find(item => normalized(item) === normalized(name)) : undefined;
  const value = id || (resolvedName ? `new:${resolvedName}` : '');
  return <label className="field" data-field-error={!!error}>{label}<select value={value} aria-invalid={!!error} aria-describedby={error ? `${fieldId}-error` : undefined} onChange={event => { const next = event.target.value; if (next.startsWith('new:')) onChange(null, next.slice(4)); else onChange(next || null, people.find(person => person.id === next)?.name || name); }}><option value="">Выберите человека</option>{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}{[...new Set(newNames)].map(newName => <option key={newName} value={`new:${newName}`}>{newName} · новый человек</option>)}</select>{!value && name && <span className="archive-proposal-suggestion">В рассказе: {name}</span>}{error && <span id={`${fieldId}-error`} className="archive-field-error" role="alert">{error}</span>}</label>;
}
