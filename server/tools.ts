import { tool } from 'ai';
import { z } from 'zod';
import type { LifeEvent, Person, Provenance, Relation, Tree } from '../shared/types.js';
import { reconcileResearchWithTree, recordRelationshipRemoval, recordTreePerson, recordTreeRelationship } from './research-store.js';
import { change, getTree, newPerson, newRelation } from './tree-store.js';
import { withPersistenceTransaction } from './persistence-transaction.js';

export function evidenceSafeRelationProvenance(personProvenances: Provenance[], requested: Provenance): Provenance {
  return personProvenances.includes('hypothesis') ? 'hypothesis' : requested;
}

export function requireDocumentSource(provenanceValue: Provenance, source?: string): void {
  const reference = source?.trim() ?? '';
  const isUrl = /^https?:\/\/[^\s]+$/i.test(reference);
  const isArchiveReference = /(?:^|[,;\s])ф\.?\s*\S+/iu.test(reference)
    && /(?:^|[,;\s])оп\.?\s*\S+/iu.test(reference)
    && /(?:^|[,;\s])д\.?\s*\S+/iu.test(reference);
  if (provenanceValue === 'document' && !isUrl && !isArchiveReference) {
    throw new Error('Для provenance=document нужна реальная ссылка или архивный шифр источника.');
  }
}

const provenance = z.enum(['told', 'document', 'hypothesis'])
  .describe('told — человек сам рассказал; document — есть документ со ссылкой; hypothesis — твой вывод (например, имя отца из отчества).');
const year = z.number().int().min(1000).max(2100);

const lifeFields = {
  sex: z.enum(['male', 'female']).optional(),
  birthYear: year.optional(),
  birthApproximate: z.boolean().optional().describe('true, если год примерный («около», «вроде»)'),
  birthPlace: z.string().max(200).optional(),
  deathYear: year.optional(),
  deathApproximate: z.boolean().optional(),
  deathPlace: z.string().max(200).optional(),
  note: z.string().max(600).optional().describe('Короткая заметка: профессия, сословие, история — только сказанное пользователем'),
  source: z.string().max(400).optional().describe('Для document — ссылка или шифр архивного дела'),
};

function event(yearValue?: number, approximate?: boolean, place?: string): LifeEvent | undefined {
  if (yearValue === undefined && !place) return undefined;
  return { year: yearValue, approximate: approximate || undefined, place: place?.trim() || undefined };
}

function find(tree: Tree, id: string): Person {
  const person = tree.people.find(p => p.id === id);
  if (!person) throw new Error(`Нет человека с id ${id}. Смотри текущее древо в контексте.`);
  return person;
}

function link(tree: Tree, input: Omit<Relation, 'id'>): Relation {
  if (input.fromId === input.toId) throw new Error('Нельзя связать человека с самим собой.');
  find(tree, input.fromId);
  find(tree, input.toId);
  const duplicate = tree.relations.find(r => r.type === input.type && (
    (r.fromId === input.fromId && r.toId === input.toId) ||
    (input.type === 'spouse' && r.fromId === input.toId && r.toId === input.fromId)
  ));
  if (duplicate) return duplicate;
  if (input.type === 'parent') {
    const parents = tree.relations.filter(r => r.type === 'parent' && r.toId === input.toId);
    if (parents.length >= 2) throw new Error('У этого человека уже два родителя в древе.');
    if (isAncestor(tree, input.toId, input.fromId)) throw new Error('Так получится цикл: ребёнок уже числится предком этого родителя.');
    const childParents = parents.map(r => r.fromId);
    if (childParents.some(parentId => isAncestor(tree, input.fromId, parentId))) {
      throw new Error('Этот человек уже предок одного из родителей ребёнка (например, бабушка). Скорее всего, связь не та: проверь, кем он приходится, и при необходимости убери старую связь через unlink_people.');
    }
    const childAncestorsOf = (id: string) => tree.relations.filter(r => r.type === 'parent' && r.fromId === id).map(r => r.toId);
    if (childAncestorsOf(input.fromId).some(otherChild => isAncestor(tree, otherChild, input.toId))) {
      throw new Error('Этот человек уже родитель одного из предков ребёнка. Проверь поколение: возможно, он бабушка или дедушка, а не родитель.');
    }
  }
  const relation = newRelation(input);
  tree.relations.push(relation);
  return relation;
}

/** True if ancestorId is a parent, grandparent, … of personId. */
function isAncestor(tree: Tree, ancestorId: string, personId: string, seen = new Set<string>()): boolean {
  for (const r of tree.relations) {
    if (r.type !== 'parent' || r.toId !== personId || seen.has(r.fromId)) continue;
    if (r.fromId === ancestorId) return true;
    seen.add(r.fromId);
    if (isAncestor(tree, ancestorId, r.fromId, seen)) return true;
  }
  return false;
}

export const treeTools = {
  add_person: tool({
    description: 'Добавить человека в древо. Сразу укажи его связи с уже существующими людьми. Перед добавлением проверь, нет ли его уже в древе.',
    inputSchema: z.object({
      name: z.string().min(1).max(160).describe('Только имя или ФИО, как известно: «Иван Петрович Соколов», «Нина». Без пояснений — они идут в note.'),
      provenance,
      ...lifeFields,
      links: z.array(z.object({
        kind: z.enum(['parent_of', 'child_of', 'spouse_of']).describe('parent_of — новый человек родитель personId; child_of — ребёнок personId'),
        personId: z.string(),
        provenance: provenance.optional(),
        source: z.string().max(400).optional().describe('Для document — реальная ссылка или архивный шифр источника'),
      })).max(8).optional(),
    }),
    execute: async input => withPersistenceTransaction(() => {
      requireDocumentSource(input.provenance, input.source);
      const createdRelations: Relation[] = [];
      const person = change(`Добавлен: ${input.name}`, tree => {
        const created = newPerson({
          name: input.name.trim(),
          sex: input.sex,
          birth: event(input.birthYear, input.birthApproximate, input.birthPlace),
          death: event(input.deathYear, input.deathApproximate, input.deathPlace),
          note: input.note?.trim() || undefined,
          provenance: input.provenance,
          source: input.source,
        });
        tree.people.push(created);
        for (const item of input.links ?? []) {
          const existingPerson = find(tree, item.personId);
          const relationProvenance = evidenceSafeRelationProvenance(
            [input.provenance, existingPerson.provenance],
            item.provenance ?? input.provenance,
          );
          const relationSource = item.source ?? input.source;
          requireDocumentSource(relationProvenance, relationSource);
          if (item.kind === 'parent_of') createdRelations.push(link(tree, { type: 'parent', fromId: created.id, toId: item.personId, provenance: relationProvenance, source: relationSource }));
          if (item.kind === 'child_of') createdRelations.push(link(tree, { type: 'parent', fromId: item.personId, toId: created.id, provenance: relationProvenance, source: relationSource }));
          if (item.kind === 'spouse_of') createdRelations.push(link(tree, { type: 'spouse', fromId: created.id, toId: item.personId, provenance: relationProvenance, source: relationSource }));
        }
        return created;
      });
      recordTreePerson(person);
      const people = getTree().people;
      for (const relation of createdRelations) recordTreeRelationship(relation, people);
      return { id: person.id, name: person.name, provenance: person.provenance };
    }),
  }),

  update_person: tool({
    description: 'Уточнить сведения о человеке, который уже есть в древе (имя, годы, места, заметку, происхождение).',
    inputSchema: z.object({
      id: z.string(),
      name: z.string().min(1).max(160).optional(),
      provenance: provenance.optional(),
      ...lifeFields,
    }),
    execute: async input => withPersistenceTransaction(() => {
      const person = change('Уточнены сведения', tree => {
        const updated = find(tree, input.id);
        if (input.name) updated.name = input.name.trim();
        if (input.provenance) updated.provenance = input.provenance;
        if (input.sex) updated.sex = input.sex;
        if (input.note) updated.note = input.note.trim();
        if (input.source) updated.source = input.source;
        const birth = event(input.birthYear, input.birthApproximate, input.birthPlace);
        if (birth) updated.birth = { ...updated.birth, ...stripUndefined(birth) };
        const death = event(input.deathYear, input.deathApproximate, input.deathPlace);
        if (death) updated.death = { ...updated.death, ...stripUndefined(death) };
        requireDocumentSource(updated.provenance, updated.source);
        return structuredClone(updated);
      });
      const changedFields = [
        input.name !== undefined && 'name',
        (input.birthYear !== undefined || input.birthApproximate !== undefined) && 'birth-date',
        input.birthPlace !== undefined && 'birth-place',
        (input.deathYear !== undefined || input.deathApproximate !== undefined) && 'death-date',
        input.deathPlace !== undefined && 'death-place',
        input.note !== undefined && 'biographical-note',
      ].filter((item): item is string => Boolean(item));
      recordTreePerson(person, changedFields);
      return { id: person.id, name: person.name };
    }),
  }),

  link_people: tool({
    description: 'Связать двух людей, которые уже есть в древе.',
    inputSchema: z.object({
      type: z.enum(['parent', 'spouse']),
      fromId: z.string().describe('Для parent — родитель'),
      toId: z.string().describe('Для parent — ребёнок'),
      provenance,
      source: z.string().max(400).optional().describe('Для document — реальная ссылка или архивный шифр источника'),
    }),
    execute: async input => withPersistenceTransaction(() => {
      const relation = change('Добавлена связь', tree => {
        const people = [find(tree, input.fromId), find(tree, input.toId)];
        const relationProvenance = evidenceSafeRelationProvenance(people.map(person => person.provenance), input.provenance);
        requireDocumentSource(relationProvenance, input.source);
        return structuredClone(link(tree, { ...input, provenance: relationProvenance }));
      });
      const people = getTree().people;
      recordTreeRelationship(relation, people);
      return { id: relation.id, from: people.find(person => person.id === relation.fromId)?.name, to: people.find(person => person.id === relation.toId)?.name, type: relation.type };
    }),
  }),

  unlink_people: tool({
    description: 'Убрать ошибочную связь между двумя людьми (например, если человека отнесли не к тому родителю). Люди остаются в древе.',
    inputSchema: z.object({
      relationId: z.string().optional().describe('id связи из текущего древа'),
      fromId: z.string().optional(),
      toId: z.string().optional(),
    }),
    execute: async input => withPersistenceTransaction(() => {
      const result = change('Убрана связь', tree => {
        const relation = tree.relations.find(r => input.relationId
          ? r.id === input.relationId
          : (r.fromId === input.fromId && r.toId === input.toId) || (r.type === 'spouse' && r.fromId === input.toId && r.toId === input.fromId));
        if (!relation) throw new Error('Такой связи нет. Смотри id связей в текущем древе.');
        const output = { relation: structuredClone(relation), from: find(tree, relation.fromId).name, to: find(tree, relation.toId).name, type: relation.type };
        tree.relations = tree.relations.filter(r => r.id !== relation.id);
        return output;
      });
      recordRelationshipRemoval(result.relation);
      return { from: result.from, to: result.to, type: result.type };
    }),
  }),

  remove_person: tool({
    description: 'Убрать человека из древа — только если пользователь прямо сказал, что это ошибка или дубль.',
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => withPersistenceTransaction(() => {
      const result = change('Человек удалён', tree => {
      const person = find(tree, id);
      tree.people = tree.people.filter(p => p.id !== id);
      tree.relations = tree.relations.filter(r => r.fromId !== id && r.toId !== id);
      return { removed: person.name };
      });
      reconcileResearchWithTree(getTree());
      return result;
    }),
  }),
};

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Compact, model-readable view of the current tree. */
export function treeContext(): string {
  const { people, relations } = getTree();
  if (people.length === 0) return 'Древо пока пустое.';
  const name = (id: string) => people.find(p => p.id === id)?.name ?? id;
  const years = (e?: LifeEvent) => (e?.year ? `${e.approximate ? '≈' : ''}${e.year}` : '?');
  const lines = people.map(p => {
    const life = p.birth || p.death ? ` ${years(p.birth)}–${p.death ? years(p.death) : ''}` : '';
    const place = p.birth?.place ? `, ${p.birth.place}` : '';
    return `- [${p.id}] ${p.name}${life}${place} (${p.provenance})${p.note ? ` — ${p.note}` : ''}`;
  });
  const links = relations.map(r => r.type === 'parent'
    ? `- [${r.id}] ${name(r.fromId)} — родитель — ${name(r.toId)} (${r.provenance})`
    : `- [${r.id}] ${name(r.fromId)} и ${name(r.toId)} — супруги (${r.provenance})`);
  return `Люди:\n${lines.join('\n')}\n\nСвязи:\n${links.join('\n') || '- пока нет'}`;
}
