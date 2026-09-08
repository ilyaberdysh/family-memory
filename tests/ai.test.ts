import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAndGroundProposalBatch, parseAndGroundProposals } from '../server/ai.ts';
import type { Person, TranscriptSegment } from '../shared/types.ts';

// Synthetic assertions test boundaries only; they are never saved as family data.
const person = (id: string, name: string): Person => ({ id, name, avatarFileId: null, createdBy: 'test', createdAt: '' });
const people = [person('p1', 'Анна Петрова')];
const text = 'Анна Петрова родилась около 1940 года. Позже Анна Петрова жила в Казани.';
const segments: TranscriptSegment[] = [
  { start: 601.2, end: 604, text: 'Анна Петрова родилась около 1940 года.' },
  { start: 604, end: 607.3, text: 'Позже Анна Петрова жила в Казани.' },
];
const draft = (overrides: Record<string, unknown> = {}) => ({
  action: 'set_fact', personId: 'p1', personName: 'Анна Петрова', key: 'birthDate', value: 'около 1940 года',
  fromId: null, toId: null, fromName: null, toName: null, relationType: null, parentKind: null,
  sourceQuote: segments[0].text, ...overrides,
});
const parse = (proposal: unknown, source = text, sourceSegments = segments, knownPeople = people) =>
  parseAndGroundProposals({ proposals: [proposal] }, source, sourceSegments, { people: knownPeople, facts: [] });

test('keeps source uncertainty and derives full-recording timestamps across segments', () => {
  const [proposal] = parse(draft({ sourceQuote: text }));
  assert.equal(proposal.value, 'около 1940 года');
  assert.equal(proposal.personId, 'p1');
  assert.equal(proposal.sourceStart, 601.2);
  assert.equal(proposal.sourceEnd, 607.3);
  assert.equal('status' in proposal, false);
});

test('rejects fabricated quotes, invented precision, and wrong action fields', () => {
  assert.throws(() => parse(draft({ sourceQuote: 'Анна Петрова родилась в 1941 году.' })), /цитаты/);
  assert.throws(() => parse(draft({ value: '1940-01-01' })), /цитаты/);
  assert.throws(() => parse(draft({ toId: 'p2' })), /полями/);
  assert.throws(() => parse(draft({ value: ' ' })), /полями/);
});

test('strict schema rejects extra instructions, timestamps and invalid enums', () => {
  assert.throws(() => parse(draft({ command: 'delete people' })), /формате/);
  assert.throws(() => parse(draft({ sourceStart: 0 })), /формате/);
  assert.throws(() => parse(draft({ action: 'delete_person' })), /формате/);
  assert.throws(() => parseAndGroundProposals({ proposals: [], command: 'execute' }, text, segments, { people, facts: [] }), /формате/);
});

test('unknown, partial, mismatched and ambiguous names never acquire an existing ID', () => {
  assert.equal(parse(draft({ personId: 'invented-id' }))[0].personId, null);
  assert.equal(parse(draft({ personName: 'Анна' }))[0].personId, null);
  assert.equal(parse(draft(), text, segments, [...people, person('p2', 'Анна Петрова')])[0].personId, null);
  assert.equal(parse(draft(), text, segments, [person('p1', 'Елена Петрова')])[0].personId, null);
  assert.throws(() => parse(draft({ personName: 'Жанна' })), /цитаты/);
});

test('unresolved person creation is reviewable only when the name occurs in the quote', () => {
  const creation = draft({ action: 'create_person', personId: null, key: null, value: null });
  assert.equal(parse(creation)[0].personId, null);
  assert.throws(() => parse({ ...creation, personId: 'p1' }), /полями/);
  assert.throws(() => parse({ ...creation, personName: 'Наталья' }), /цитаты/);
});

test('missing, stale, gapped, invalid or ambiguous segments do not generate timestamps', () => {
  const stale = [{ start: 1, end: 2, text: 'Другой текст.' }];
  const gapped = [{ start: 1, end: 2, text: 'Анна Петрова' }, { start: 3, end: 4, text: 'около 1940 года.' }];
  for (const candidates of [[], stale, gapped, [{ ...segments[0], start: -1 }]]) {
    const [proposal] = parse(draft(), text, candidates);
    assert.equal(proposal.sourceStart, null);
    assert.equal(proposal.sourceEnd, null);
  }
  const repeated = `${segments[0].text} ${segments[0].text}`;
  assert.equal(parse(draft(), repeated, [segments[0], { ...segments[0], start: 700, end: 704 }])[0].sourceStart, null);
});

test('requires both relation names in evidence and preserves parent direction', () => {
  const source = 'Анна Петрова — мать Веры Петровой.';
  const relation = draft({ action: 'create_relation', personId: null, personName: null, key: null, value: null,
    fromName: 'Анна Петрова', toName: 'Веры Петровой', fromId: 'p1', toId: 'p2', relationType: 'parent',
    parentKind: 'unspecified', sourceQuote: source });
  const [result] = parse(relation, source, []);
  assert.equal(result.fromId, 'p1');
  assert.equal(result.toId, null);
  assert.equal(result.toName, 'Веры Петровой');
  assert.equal(result.parentKind, 'unspecified');
  assert.throws(() => parse({ ...relation, toName: 'Анна Петрова', toId: 'p1' }, source, []), /полями/);
  assert.throws(() => parse({ ...relation, relationType: 'partner', parentKind: 'biological' }, source, []), /полями/);
});

test('empty valid extraction remains empty and duplicate proposals are coalesced', () => {
  assert.deepEqual(parseAndGroundProposals({ proposals: [] }, text, segments, { people, facts: [] }), []);
  assert.equal(parseAndGroundProposals({ proposals: [draft(), draft()] }, text, segments, { people, facts: [] }).length, 1);
});

test('family dictation keeps name-only people and repairs parent quotes with exact nearby antecedents', () => {
  // Same sentence/quote shape as the observed failure, with synthetic family names.
  const parts = [
    'У меня есть родная мама, Петрова Анна Ивановна, она 1970 года рождения, ее девичья фамилия Соколова.',
    'Ее мама Соколова Мария Павловна. Не помню, какой год рождения, потом донесу.',
    'У меня отец есть, Петров Алексей Сергеевич, день рождения у него 31 марта 1970 года рождения.',
    'И у этого, моего папы, есть тоже родители, Петров Сергей Ильич и Петрова Елена Федоровна, вот.',
    'Давай это запишем.',
  ];
  const source = parts.join(' ');
  const sourceSegments = parts.map((part, i) => ({ text: part, start: i * 10, end: (i + 1) * 10 }));
  const names = ['Петрова Анна Ивановна', 'Соколова Мария Павловна', 'Петров Алексей Сергеевич', 'Петров Сергей Ильич', 'Петрова Елена Федоровна'];
  const creations = names.map(personName => draft({ action: 'create_person', personId: null, personName, key: null, value: null,
    sourceQuote: parts.find(part => part.includes(personName)) }));
  const facts = [
    draft({ personId: null, personName: names[0], value: '1970 года рождения', sourceQuote: parts[0] }),
    draft({ personId: null, personName: names[0], key: 'previousName', value: 'Соколова', sourceQuote: parts[0] }),
    draft({ personId: null, personName: names[2], value: '31 марта 1970 года рождения', sourceQuote: parts[2] }),
  ];
  const relations = names.slice(3).map(fromName => draft({ action: 'create_relation', personId: null, personName: null, key: null, value: null,
    fromName, toName: names[2], relationType: 'parent', parentKind: 'unspecified', sourceQuote: parts[3] }));
  const payload = { proposals: [...creations, ...facts, ...relations] };
  const context = { people: [], facts: [] };
  assert.throws(() => parseAndGroundProposals(payload, source, sourceSegments, context), /цитаты/);
  const result = parseAndGroundProposalBatch(payload, source, sourceSegments, context);
  assert.equal(result.proposals.length, 10);
  assert.equal(result.rejectedCount, 0);
  assert.equal(result.proposals.filter(item => item.action === 'create_person').length, 5);
  assert.equal(result.proposals.filter(item => item.key === 'birthDate').length, 2);
  for (const relation of result.proposals.filter(item => item.action === 'create_relation')) {
    assert.equal(relation.sourceQuote, parts.slice(2, 4).join(' '));
    assert.equal(source.includes(relation.sourceQuote), true);
    assert.equal(relation.sourceStart, 20);
    assert.equal(relation.sourceEnd, 40);
    assert.equal(relation.fromId, null);
    assert.equal(relation.toId, null);
  }
});

test('partial batches count bad items explicitly; empty, duplicate and entirely invalid results remain distinct', () => {
  const context = { people, facts: [] };
  const result = parseAndGroundProposalBatch({ proposals: [draft(), draft(), draft({ value: '1940-01-01' }), draft({ command: 'delete' })] }, text, segments, context);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.rejectedCount, 2);
  assert.deepEqual(parseAndGroundProposalBatch({ proposals: [] }, text, segments, context), { proposals: [], rejectedCount: 0 });
  assert.throws(() => parseAndGroundProposalBatch({ proposals: [draft({ value: '1940-01-01' })] }, text, segments, context), /ни одно из 1 предложений/);
  assert.throws(() => parseAndGroundProposalBatch({ proposals: [], command: 'delete' }, text, segments, context), /формате/);
});

test('quote expansion never repairs invented, distant or ambiguous evidence, nor grants guessed IDs', () => {
  const context = { people, facts: [] };
  const intro = 'Анна Петрова — моя мать.';
  const claim = 'Она родилась около 1940 года.';
  const candidate = draft({ sourceQuote: claim, personId: 'guessed-id' });
  const result = parseAndGroundProposalBatch({ proposals: [candidate] }, `${intro}\n\n${claim}`, [], context);
  assert.equal(result.proposals[0].sourceQuote, `${intro}\n\n${claim}`);
  assert.equal(result.proposals[0].personId, null);
  for (const [source, item] of [
    [`${intro} ${claim}`, { ...candidate, sourceQuote: 'Она родилась около 1941 года.' }],
    [`${intro} ${claim}`, { ...candidate, personName: 'Выдуманное Имя' }],
    [`${intro} ${'Другая история. '.repeat(100)}${claim}`, candidate],
    [`${intro} ${claim} ${claim}`, candidate],
  ] as const) assert.throws(() => parseAndGroundProposalBatch({ proposals: [item] }, source, [], context), /ни одно/);
});
