import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PRODUCT_INSTRUCTIONS } from '../server/agent.js';
import { RESEARCH_CORE } from '../server/research-instructions.js';
import { researchPolicyDirectives, type ResearchPolicyCode } from '../server/research-policy.js';

type UpstreamCase = { id: string; request: string };

const evalSource = fs.readFileSync(new URL('../vendor/ex-ussr-kinship-research/evals/discovery-and-logic.yaml', import.meta.url), 'utf8');
const logicSection = evalSource.split('\nlogic_cases:\n')[1];
if (!logicSection) throw new Error('Upstream eval file has no logic_cases section.');
const cases = [...logicSection.matchAll(/^  - id: ([^\n]+)\n    request: ("(?:[^"\\]|\\.)*")/gm)]
  .map((match): UpstreamCase => ({ id: match[1].trim(), request: JSON.parse(match[2]) as string }));

const expectedById: Record<string, ResearchPolicyCode[]> = {
  namesakes_same_village: ['namesakes-separate'],
  copied_indexes: ['dependent-copies'],
  conflicting_birth_dates: ['preserve-conflict'],
  captcha: ['captcha-human-only'],
  reply_in_user_language: [],
  unindexed_scans: ['unindexed-scan'],
  house_number_identity: ['namesakes-separate'],
  birthplace_conflict: ['preserve-conflict', 'birthplace-distinction', 'grandparent-two-edges'],
  sources_exhausted: ['sources-exhausted', 'grandparent-two-edges'],
  repression_list: ['repression-caution'],
  living_person: ['living-person-privacy'],
  direct_single_record: ['direct-record-single-source'],
  grandparent_chain: ['grandparent-two-edges'],
};

test('every vendored upstream logic eval is executable', () => {
  assert.ok(cases.length > 0);
  assert.deepEqual(cases.map(item => item.id).sort(), Object.keys(expectedById).sort());
});

for (const scenario of cases) {
  test(`policy eval: ${scenario.id}`, () => {
    const actual = researchPolicyDirectives(scenario.request).map(item => item.code);
    for (const code of expectedById[scenario.id]) assert.ok(actual.includes(code), `${scenario.id}: missing ${code}; got ${actual.join(', ')}`);
    if (scenario.id === 'reply_in_user_language') {
      assert.match(PRODUCT_INSTRUCTIONS, /На языке последнего сообщения пользователя/);
      assert.match(RESEARCH_CORE, /Запросы составляй на языке источника/);
      assert.match(RESEARCH_CORE, /цитаты сохраняй в оригинальном написании/);
    }
  });
}

test('unknown intermediate generation stays hypothetical', () => {
  const directive = researchPolicyDirectives('Это мой дед, но имя его ребёнка — моего родителя — неизвестно.')
    .find(item => item.code === 'grandparent-two-edges');
  assert.match(directive?.instruction ?? '', /provenance hypothesis/);
  assert.match(directive?.instruction ?? '', /оба ребра.*hypothesis/);
});
