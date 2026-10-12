import { tool } from 'ai';
import { z } from 'zod';
import type { LifeEvent, Person, Relation, Tree } from '../shared/types.js';
import { change, getTree, newPerson, newRelation } from './tree-store.js';

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
    const reverse = tree.relations.some(r => r.type === 'parent' && r.fromId === input.toId && r.toId === input.fromId);
    if (reverse) throw new Error('Обратная связь уже есть: ребёнок не может быть родителем своего родителя.');
  }
  const relation = newRelation(input);
  tree.relations.push(relation);
  return relation;
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
      })).max(8).optional(),
    }),
    execute: async input => change(`Добавлен: ${input.name}`, tree => {
      const person = newPerson({
        name: input.name.trim(),
        sex: input.sex,
        birth: event(input.birthYear, input.birthApproximate, input.birthPlace),
        death: event(input.deathYear, input.deathApproximate, input.deathPlace),
        note: input.note?.trim() || undefined,
        provenance: input.provenance,
        source: input.source,
      });
      tree.people.push(person);
      for (const item of input.links ?? []) {
        const relationProvenance = item.provenance ?? input.provenance;
        if (item.kind === 'parent_of') link(tree, { type: 'parent', fromId: person.id, toId: item.personId, provenance: relationProvenance });
        if (item.kind === 'child_of') link(tree, { type: 'parent', fromId: item.personId, toId: person.id, provenance: relationProvenance });
        if (item.kind === 'spouse_of') link(tree, { type: 'spouse', fromId: person.id, toId: item.personId, provenance: relationProvenance });
      }
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
    execute: async input => change('Уточнены сведения', tree => {
      const person = find(tree, input.id);
      if (input.name) person.name = input.name.trim();
      if (input.provenance) person.provenance = input.provenance;
      if (input.sex) person.sex = input.sex;
      if (input.note) person.note = input.note.trim();
      if (input.source) person.source = input.source;
      const birth = event(input.birthYear, input.birthApproximate, input.birthPlace);
      if (birth) person.birth = { ...person.birth, ...stripUndefined(birth) };
      const death = event(input.deathYear, input.deathApproximate, input.deathPlace);
      if (death) person.death = { ...person.death, ...stripUndefined(death) };
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
    }),
    execute: async input => change('Добавлена связь', tree => {
      const relation = link(tree, input);
      return { id: relation.id, from: find(tree, relation.fromId).name, to: find(tree, relation.toId).name, type: relation.type };
    }),
  }),

  remove_person: tool({
    description: 'Убрать человека из древа — только если пользователь прямо сказал, что это ошибка или дубль.',
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => change('Человек удалён', tree => {
      const person = find(tree, id);
      tree.people = tree.people.filter(p => p.id !== id);
      tree.relations = tree.relations.filter(r => r.fromId !== id && r.toId !== id);
      return { removed: person.name };
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
    ? `- ${name(r.fromId)} → родитель → ${name(r.toId)} (${r.provenance})`
    : `- ${name(r.fromId)} ⟷ супруги ⟷ ${name(r.toId)} (${r.provenance})`);
  return `Люди:\n${lines.join('\n')}\n\nСвязи:\n${links.join('\n') || '- пока нет'}`;
}
