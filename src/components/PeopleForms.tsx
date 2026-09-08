import { useId, useState } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import { api, json } from '../api';
import { Modal, Avatar, useUnsavedChanges } from './ui';
import { FACT_LABELS, type AppState, type Person, type Fact, type FactKey, type Relation, type NameParts } from '../../shared/types';
import { EMPTY_NAME_PARTS, NAME_PART_MAX_LENGTH, fullName, cleanNameParts, dateInputError, DATE_INPUT_HINT, formatFamilyDate, isDateFact } from '../../shared/person-fields';

export function NamePartsFields({ value, onChange, autoFocus = false }: { value: NameParts; onChange: (parts: NameParts) => void; autoFocus?: boolean }) {
  return <div className="form-grid">{([['lastName', 'Фамилия'], ['firstName', 'Имя'], ['patronymic', 'Отчество']] as const).map(([key, label], index) => <label className="field" key={key}>{label}{key === 'patronymic' && <span className="muted">необязательно</span>}<input autoFocus={autoFocus && index === 0} value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} maxLength={NAME_PART_MAX_LENGTH} autoComplete="off" placeholder={key === 'patronymic' ? 'Если известно' : label} /></label>)}</div>;
}
export function FamilyDateField({ label, value, onChange, optional = true }: { label: string; value: string; onChange: (value: string) => void; optional?: boolean }) {
  const id = useId(); const [touched, setTouched] = useState(false); const error = touched ? dateInputError(value) : null;
  return <label className="field">{label}{optional && <span className="muted">необязательно</span>}<input value={value} onChange={event => onChange(event.target.value)} onBlur={() => setTouched(true)} placeholder="ДД.ММ.ГГГГ" maxLength={200} aria-invalid={!!error} aria-describedby={`${id}-hint`} /><small id={`${id}-hint`} className={error ? 'error-message' : 'form-hint'}>{error || DATE_INPUT_HINT}</small></label>;
}

export function PersonForm({ state, relativeId, onClose, onSaved }: { state: AppState; relativeId?: string; onClose: () => void; onSaved: (person: Person) => Promise<void> }) {
  const [nameParts, setNameParts] = useState<NameParts>({ ...EMPTY_NAME_PARTS });
  const [values, setValues] = useState<Record<string, string>>({}); const [source, setSource] = useState('');
  const [relation, setRelation] = useState('child'); const [parentKind, setParentKind] = useState('unspecified'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const name = fullName(nameParts); const related = state.people.find(person => person.id === relativeId);
  const knownParts = Object.values(cleanNameParts(nameParts)).filter(Boolean).map(part => part.toLocaleLowerCase('ru'));
  const matches = name.length > 2 ? state.people.filter(person => knownParts.every(part => person.name.toLocaleLowerCase('ru').includes(part))) : [];
  const dirty = Boolean(name || source || Object.values(values).some(Boolean) || relation !== 'child' || parentKind !== 'unspecified'); useUnsavedChanges(dirty);
  function close() { if (busy || (dirty && !confirm('Закрыть форму без сохранения?'))) return; onClose(); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (!name) { setError('Укажите хотя бы одну известную часть имени.'); return; }
    for (const key of ['birthDate', 'deathDate']) { const issue = dateInputError(values[key] || ''); if (issue) { setError(`${key === 'birthDate' ? 'Дата рождения' : 'Дата смерти'}: ${issue}`); return; } }
    setBusy(true);
    try { const person = await api<Person>('/api/people', json('POST', { name, nameParts: cleanNameParts(nameParts), facts: values, source, relation: relativeId ? { relativeId, type: relation, parentKind } : undefined })); await onSaved(person); onClose(); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <Modal open onClose={close} title={related ? 'Добавить родственника' : 'Новый человек'}><form onSubmit={submit} className="form-stack">
    <NamePartsFields value={nameParts} onChange={setNameParts} autoFocus /><p className="form-hint">Укажите известные части имени. Остальное можно оставить пустым.</p>
    {matches.length > 0 && <div className="inline-note"><Search size={16} /><div>Похожие имена уже есть в дереве:<br />{matches.slice(0, 4).map(person => <span key={person.id}>{person.name}<br /></span>)}<small>Если это тот же человек, добавьте связь между существующими людьми.</small></div></div>}
    {related && <div className="related-context"><Avatar name={related.name} fileId={related.avatarFileId} size={36} /><div><small>Связь с человеком</small><strong>{related.name}</strong></div><select aria-label="Родственная связь" value={relation} onChange={event => setRelation(event.target.value)}><option value="child">Его / её ребёнок</option><option value="parent">Его / её родитель</option><option value="partner">Партнёр</option></select></div>}
    {related && relation !== 'partner' && <label className="field">Родительство<select value={parentKind} onChange={event => setParentKind(event.target.value)}><option value="unspecified">Не уточнено</option><option value="biological">Биологическое</option><option value="adoptive">Усыновление</option></select></label>}
    <div className="form-grid"><FamilyDateField label="Дата рождения" value={values.birthDate || ''} onChange={value => setValues(previous => ({ ...previous, birthDate: value }))} /><FamilyDateField label="Дата смерти" value={values.deathDate || ''} onChange={value => setValues(previous => ({ ...previous, deathDate: value }))} />{(['previousName', 'place'] as FactKey[]).map(key => <label className="field" key={key}>{FACT_LABELS[key]}<input maxLength={300} value={values[key] || ''} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} placeholder="Необязательно" /></label>)}</div>
    <label className="field">Откуда сведения<input maxLength={1000} value={source} onChange={event => setSource(event.target.value)} placeholder="Например, со слов родственника" /></label><p className="form-hint">Новые сведения видны сразу, с пометкой «Не подтверждено».</p>
    {error && <p className="error-message" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button disabled={busy || !name} className="button primary">{busy && <LoaderCircle size={16} className="spin" />}Добавить человека</button></div>
  </form></Modal>;
}

export function FactForm({ personId, fact, availableKeys, onClose, onSaved }: { personId: string; fact?: Fact; availableKeys: FactKey[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [key, setKey] = useState<FactKey>(fact?.key || availableKeys[0] || 'bio');
  const [value, setValue] = useState(fact && isDateFact(fact.key) ? formatFamilyDate(fact.value) : fact?.value || '');
  const [nameParts, setNameParts] = useState<NameParts>(fact?.nameParts ? { ...fact.nameParts } : { ...EMPTY_NAME_PARTS });
  const [structuredName, setStructuredName] = useState(!fact || !!fact.nameParts);
  const [source, setSource] = useState(fact?.source || ''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submittedValue = key === 'name' && structuredName ? fullName(nameParts) : value;
  const initialValue = fact && isDateFact(fact.key) ? formatFamilyDate(fact.value) : fact?.value || '';
  const dirty = (key === 'name' ? submittedValue !== (fact?.value || '') || (structuredName && JSON.stringify(cleanNameParts(nameParts)) !== JSON.stringify(fact?.nameParts)) : value !== initialValue) || source !== (fact?.source || ''); useUnsavedChanges(dirty);
  function close() { if (busy || (dirty && !confirm('Закрыть форму без сохранения?'))) return; onClose(); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (isDateFact(key)) { const issue = dateInputError(value); if (issue) { setError(issue); return; } }
    if (!submittedValue.trim()) { setError(key === 'name' ? 'Укажите хотя бы одну известную часть имени.' : 'Укажите значение сведения.'); return; }
    setBusy(true);
    try { const fields = { value: submittedValue, source, ...(key === 'name' && structuredName ? { nameParts: cleanNameParts(nameParts) } : {}) }; await api(fact ? `/api/facts/${fact.id}` : '/api/facts', json(fact ? 'PATCH' : 'POST', fact ? { ...fields, version: fact.version } : { ...fields, personId, key })); await onSaved(); onClose(); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <Modal open onClose={close} title={fact ? 'Изменить сведение' : 'Добавить сведение'}><form className="form-stack" onSubmit={submit}>
    {!fact && <label className="field">Что добавить<select value={key} onChange={event => setKey(event.target.value as FactKey)}>{availableKeys.map(item => <option key={item} value={item}>{FACT_LABELS[item]}</option>)}</select></label>}
    {key === 'name' ? structuredName ? <><NamePartsFields value={nameParts} onChange={setNameParts} autoFocus /><p className="form-hint">Неизвестные части имени можно оставить пустыми.</p>{fact && !fact.nameParts && <button type="button" className="text-button" onClick={() => setStructuredName(false)}>Оставить прежнюю запись: {fact.value}</button>}</> : <><p className="inline-note">Сейчас имя записано одной строкой: «{fact?.value}». Части ФИО ещё не указаны; прежняя запись сохранится, пока вы их не уточните.</p><button type="button" className="button secondary" onClick={() => setStructuredName(true)}>Указать фамилию, имя и отчество</button></> : isDateFact(key) ? <FamilyDateField label={FACT_LABELS[key]} value={value} onChange={setValue} /> : <label className="field">{FACT_LABELS[key]}{key === 'bio' ? <textarea autoFocus required rows={5} maxLength={5000} value={value} onChange={event => setValue(event.target.value)} /> : <input autoFocus required maxLength={500} value={value} onChange={event => setValue(event.target.value)} />}</label>}
    <label className="field">Откуда сведения<input value={source} maxLength={1000} onChange={event => setSource(event.target.value)} placeholder="Со слов, документ, запись…" /></label>{fact?.status === 'confirmed' && <p className="form-hint">После изменения этому сведению понадобится новое подтверждение.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button className="button primary" disabled={busy || !submittedValue.trim()}>{busy && <LoaderCircle size={16} className="spin" />}Сохранить</button></div>
  </form></Modal>;
}
export function RelationForm({state,personId,relation,onClose,onSaved}:{state:AppState;personId:string;relation?:Relation;onClose:()=>void;onSaved:()=>Promise<void>}) {
 const [other,setOther]=useState(relation?(relation.fromId===personId?relation.toId:relation.fromId):'');const [type,setType]=useState(relation?(relation.type==='partner'?'partner':relation.fromId===personId?'child':'parent'):'parent');const [parentKind,setParentKind]=useState(relation?.parentKind||'unspecified');const [source,setSource]=useState(relation?.source||'');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const person=state.people.find(p=>p.id===personId)!;
 const dirty=other!==(relation?(relation.fromId===personId?relation.toId:relation.fromId):'')||type!==(relation?(relation.type==='partner'?'partner':relation.fromId===personId?'child':'parent'):'parent')||parentKind!==(relation?.parentKind||'unspecified')||source!==(relation?.source||'');useUnsavedChanges(dirty);
 function close(){if(busy)return;if(dirty&&!confirm('Закрыть форму без сохранения?'))return;onClose();}
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{await api(relation?`/api/relations/${relation.id}`:'/api/relations',json(relation?'PATCH':'POST',{fromId:type==='parent'?other:personId,toId:type==='parent'?personId:other,type:type==='partner'?'partner':'parent',parentKind,source,version:relation?.version}));await onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <Modal open onClose={close} title={relation?'Изменить связь':'Связать с родственником'}><form className="form-stack" onSubmit={submit}><p className="muted">Кем выбранный человек приходится {person.name}?</p><label className="field">Человек<select required value={other} onChange={e=>setOther(e.target.value)}><option value="">Выберите из дерева</option>{state.people.filter(p=>p.id!==personId).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="field">Связь<select value={type} onChange={e=>setType(e.target.value)}><option value="parent">Родитель</option><option value="child">Ребёнок</option><option value="partner">Партнёр</option></select></label>{type!=='partner'&&<label className="field">Родительство<select value={parentKind} onChange={e=>setParentKind(e.target.value as typeof parentKind)}><option value="unspecified">Не уточнено</option><option value="biological">Биологическое</option><option value="adoptive">Усыновление</option></select></label>}<label className="field">Откуда сведения<input value={source} maxLength={1000} onChange={e=>setSource(e.target.value)} placeholder="Необязательно"/></label>{error&&<p className="error-message" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button className="button primary" disabled={busy||!other}>{busy&&<LoaderCircle size={16} className="spin"/>}Сохранить связь</button></div></form></Modal>;
}
