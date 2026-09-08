import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFamily, relationPorts, PERSON_WIDTH, PERSON_HEIGHT } from '../src/components/tree-layout.js';

test('ancestors remain over their own child regardless of insertion order, with separate parent ports', () => {
  const people = ['paternal-grandmother', 'maternal-grandmother', 'child', 'mother', 'father', 'paternal-grandfather'].map(id => ({ id }));
  const relations = [
    { id: 'mg-m', fromId: 'maternal-grandmother', toId: 'mother', type: 'parent' as const },
    { id: 'pgm-f', fromId: 'paternal-grandmother', toId: 'father', type: 'parent' as const },
    { id: 'pgf-f', fromId: 'paternal-grandfather', toId: 'father', type: 'parent' as const },
    { id: 'm-f', fromId: 'mother', toId: 'father', type: 'partner' as const },
    { id: 'm-c', fromId: 'mother', toId: 'child', type: 'parent' as const },
    { id: 'f-c', fromId: 'father', toId: 'child', type: 'parent' as const },
  ];
  for (const order of [people, [...people].reverse()]) {
    const positions = layoutFamily(order, relations);
    const x = (id: string) => positions.get(id)!.x + PERSON_WIDTH / 2;
    const y = (id: string) => positions.get(id)!.y;
    assert.ok(Math.abs(x('maternal-grandmother') - x('mother')) < 1, 'maternal ancestor aligns with mother');
    assert.ok(Math.abs((x('paternal-grandmother') + x('paternal-grandfather')) / 2 - x('father')) < 1, 'paternal ancestors bracket father');
    assert.ok(Math.abs((x('mother') + x('father')) / 2 - x('child')) < 1, 'child sits between actual parents');
    for (const relation of relations.filter(item => item.type === 'parent')) assert.ok(y(relation.fromId) + PERSON_HEIGHT < y(relation.toId));
    const incoming = relationPorts('father', relations, positions, 'target');
    assert.equal(incoming.length, 2); assert.notEqual(incoming[0].offset, incoming[1].offset);
    assert.equal(positions.size, people.length);
  }
});

test('disconnected branches stay visible without overlapping nodes or forcing a shared ancestor', () => {
  const people = Array.from({ length: 120 }, (_, index) => ({ id: `p${index}` }));
  const relations = Array.from({ length: 40 }, (_, index) => [
    { id: `a${index}`, fromId: `p${index * 3}`, toId: `p${index * 3 + 2}`, type: 'parent' as const },
    { id: `b${index}`, fromId: `p${index * 3 + 1}`, toId: `p${index * 3 + 2}`, type: 'parent' as const },
  ]).flat();
  const positions = layoutFamily(people, relations);
  assert.equal(positions.size, 120);
  const entries = [...positions.values()];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
    assert.ok(Math.abs(a.x - b.x) >= PERSON_WIDTH || Math.abs(a.y - b.y) >= PERSON_HEIGHT, 'person cards must not overlap');
  }
});
