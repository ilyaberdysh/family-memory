import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProposal, validateProposal } from '../src/proposal-review';
import type { Fact, Person, Proposal } from '../shared/types';

const person = (id: string, name: string): Person => ({ id, name, avatarFileId: null, createdBy: 'test', createdAt: '' });
const people = [person('anna', 'Анна Петрова'), person('maria', 'Мария Петрова')];
const draft = (change: Partial<Proposal> = {}): Proposal => ({ id: 'draft', action: 'set_fact', status: 'pending', personId: null, personName: 'Анна Петрова', key: 'birthDate', value: '1940', fromId: null, toId: null, fromName: null, toName: null, relationType: null, parentKind: null, sourceQuote: 'Исходная цитата.', sourceStart: null, sourceEnd: null, baseVersion: null, ...change });

test('only a unique complete normalized name resolves; valid explicit choices and existing versions stay intact', () => {
  const facts = [{ personId: 'anna', key: 'birthDate', version: 4 }] as Fact[];
  const original = draft({ personName: '  АННА   Петрова ' });
  const resolved = resolveProposal(original, people, facts);
  assert.equal(resolved.personId, 'anna');
  assert.equal(resolved.baseVersion, 4);
  assert.equal(original.personId, null);
  assert.equal(resolved.sourceQuote, original.sourceQuote);
  for (const name of ['Анна', 'Петрова Анна', 'Анна Сидорова']) assert.equal(resolveProposal(draft({ personName: name }), people, facts).personId, null);
  assert.equal(resolveProposal(draft(), [...people, person('namesake', 'Анна Петрова')], facts).personId, null);
  assert.equal(resolveProposal(draft({ action: 'create_person', key: null, value: null }), people, facts).personId, 'anna');
  assert.equal(resolveProposal(draft({ personId: 'missing' }), people, facts).personId, 'anna');
  const explicit = resolveProposal(draft({ personId: 'maria', baseVersion: 2 }), people, facts);
  assert.equal(explicit.personId, 'maria');
  assert.equal(explicit.baseVersion, 2);
  assert.equal(resolveProposal(draft({ personId: 'anna', baseVersion: 1 }), people, facts).baseVersion, 1);
});

test('self-relations report both selectors for alias labels, resolved IDs and accepted new names', () => {
  const relation = draft({ action: 'create_relation', personName: null, key: null, value: null, relationType: 'parent', parentKind: 'unspecified' });
  const cases = [
    { ...relation, fromId: 'anna', toId: 'anna', fromName: 'Мама', toName: 'Анна Петрова' },
    resolveProposal({ ...relation, fromName: 'Анна Петрова', toName: ' АННА Петрова ' }, people, []),
    { ...relation, fromName: 'Новый Человек', toName: ' Новый   Человек ' },
  ];
  for (const proposal of cases) {
    const issues = validateProposal(proposal, people, ['Новый Человек']);
    assert.deepEqual(issues.map(issue => issue.field), ['fromId', 'toId']);
    assert.ok(issues.every(issue => /Один человек/.test(issue.message)));
  }
  assert.deepEqual(validateProposal({ ...relation, fromId: 'anna', toId: 'maria' }, people, []), []);
  assert.deepEqual(validateProposal({ ...relation, fromId: 'anna', toId: 'missing' }, people, []).map(issue => issue.field), ['toId']);
});

test('new person dependencies, required fields and invalid dates are validated at their own fields', () => {
  const proposal = draft({ personName: 'Новый Человек' });
  assert.deepEqual(validateProposal(proposal, people, []).map(issue => issue.field), ['personId']);
  assert.deepEqual(validateProposal(proposal, people, ['Новый Человек']), []);
  assert.deepEqual(validateProposal({ ...proposal, personName: 'Новый' }, people, ['Новый Человек']).map(issue => issue.field), ['personId']);
  assert.deepEqual(validateProposal(draft({ action: 'create_person', personName: ' ', key: null, value: null }), people, []).map(issue => issue.field), ['personName']);
  assert.deepEqual(validateProposal(draft({ personId: 'anna', key: null, value: '' }), people, []).map(issue => issue.field), ['key', 'value']);
  assert.deepEqual(validateProposal(draft({ personId: 'anna', value: '31.02.1940' }), people, []).map(issue => issue.field), ['value']);
  assert.deepEqual(validateProposal(draft({ personId: 'anna', value: 'около 1940 года' }), people, []), []);
  assert.deepEqual(validateProposal(draft({ action: 'create_person', personName: null, nameParts: { firstName: 'Анна', lastName: '', patronymic: '' } }), people, []), []);
});
