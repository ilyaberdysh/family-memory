import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { Person, ResearchArtifact, Tree } from '../shared/types.js';
import { RESEARCH_CORE, researchInstructionsFor, selectResearchModules } from '../server/research-instructions.js';
import { renderResearchReport } from '../server/research-report.js';
import { change, getTree, undo } from '../server/tree-store.js';
import { evidenceSafeRelationProvenance, requireDocumentSource } from '../server/tools.js';
import {
  auditEvidence,
  backfillTreeEvidence,
  captureConversationArtifacts,
  createManualArtifact,
  createManualCandidate,
  createManualClaim,
  createManualRelationship,
  getResearchCase,
  linkCandidateToTreePerson,
  recordObdRecord,
  recordObdSearch,
  recordRelationshipRemoval,
  recordTreePerson,
  recordTreeRelationship,
  registerSearchAttempt,
  reconcileResearchWithTree,
  updatePersonCandidate,
} from '../server/research-store.js';
import { interpretObdSearchPage } from '../server/sources/obd-memorial.js';
import { assertSearchSubjectEligible } from '../server/research-tools.js';
import { withPersistenceTransaction } from '../server/persistence-transaction.js';
import { updateResearchScope } from '../server/research-store.js';

let testDataDir = '';

beforeEach(() => {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-roots-evidence-'));
  process.env.DATA_DIR = testDataDir;
});

afterEach(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

test('conversation capture is idempotent and does not treat one informant as independent sources', () => {
  captureConversationArtifacts([
    { id: 'm1', text: 'Дед родился в 1902 году.' },
    { id: 'm2', text: 'Бабушка говорила, что в 1904.' },
  ]);
  captureConversationArtifacts([{ id: 'm1', text: 'Дед родился в 1902 году.' }]);
  const researchCase = getResearchCase();
  assert.equal(researchCase.artifacts.length, 2);
  assert.equal(new Set(researchCase.artifacts.map(item => item.independenceGroup)).size, 1);

  captureConversationArtifacts([{ id: 'm3', text: 'Это отдельно рассказала тётя.', informantId: 'aunt-1' }]);
  assert.equal(new Set(getResearchCase().artifacts.map(item => item.independenceGroup)).size, 2);
});

test('two namesakes remain separate candidates', () => {
  const first = createManualCandidate({ label: 'Николай Иванович Соколов', namesAsWritten: ['Николай Иванович Соколов'], rationale: 'Дом 7.' });
  const second = createManualCandidate({ label: 'Николай Иванович Соколов', namesAsWritten: ['Николай Иванович Соколов'], rationale: 'Дом 19.' });
  assert.notEqual(first.id, second.id);
  assert.equal(getResearchCase().people.length, 2);
  assert.equal(first.treePersonId, undefined);
  assert.equal(second.treePersonId, undefined);
});

test('conflicting dates coexist as claims instead of overwriting evidence', () => {
  const base: Person = { id: 'tree-1', name: 'Иван Соколов', provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' };
  captureConversationArtifacts([{ id: 'm1', text: 'В военной карточке указан 1902 год.' }]);
  recordTreePerson({ ...base, birth: { year: 1902 } });
  captureConversationArtifacts([{ id: 'm2', text: 'В записи о смерти указан 1904 год.' }]);
  recordTreePerson({ ...base, birth: { year: 1904 } });
  const birthClaims = getResearchCase().claims.filter(item => item.claimType === 'birth-date');
  assert.deepEqual(birthClaims.map(item => item.valueAsWritten), ['1902', '1904']);
  assert.equal(new Set(birthClaims.flatMap(item => item.artifactIds)).size, 2);
});

test('copied indexes in one independence group cannot be marked corroborated', () => {
  const person = createManualCandidate({ label: 'Мария', namesAsWritten: ['Мария'] });
  const first = artifact('Первый индекс', 'COPY-OF-ACT-17');
  const second = artifact('Зеркало индекса', 'COPY-OF-ACT-17');
  assert.throws(() => createManualClaim({
    claimText: 'Мария родилась в 1897 году.',
    subjectPersonIds: [person.id],
    claimType: 'birth-date',
    valueAsWritten: '1897',
    artifactIds: [first.id, second.id],
    supportingIndependenceGroups: ['COPY-OF-ACT-17'],
    contradictingArtifactIds: [],
    contradictsClaimIds: [],
    status: 'corroborated',
    confidence: 'high',
    rationale: 'Два сайта.',
  }), /две независимые группы/);
});

test('a direct primary record remains single-source without independent corroboration', () => {
  const person = createManualCandidate({ label: 'Анна', namesAsWritten: ['Анна'] });
  const source = createManualArtifact({
    sourceTitle: 'Акт рождения', sourceType: 'civil-record', personIds: [person.id], namesAsWritten: ['Анна'], summary: 'Названы оба родителя.',
    provenanceLevel: 'known', directness: 'direct', originality: 'image-of-original', independenceGroup: 'ACT-1901-17', legibility: 'clear',
  });
  const claim = createManualClaim({
    claimText: 'Родители Анны названы в акте рождения.', subjectPersonIds: [person.id], claimType: 'parents', artifactIds: [source.id],
    supportingIndependenceGroups: [source.independenceGroup], contradictingArtifactIds: [], contradictsClaimIds: [], status: 'single-source', confidence: 'high',
    rationale: 'Прямая запись с установленным происхождением, но одна независимая цепочка.',
  });
  assert.equal(claim.status, 'single-source');
  assert.deepEqual(auditEvidence().warnings, []);
});

test('grandparent relationship is represented by two parent edges', () => {
  const grandparent = createManualCandidate({ label: 'Мария', namesAsWritten: ['Мария'] });
  const parent = createManualCandidate({ label: 'Ольга', namesAsWritten: ['Ольга'] });
  const child = createManualCandidate({ label: 'Анна', namesAsWritten: ['Анна'] });
  const first = createManualRelationship({ personAId: grandparent.id, relationshipType: 'parent', personBId: parent.id, basis: 'unknown', claimIds: [], supportingArtifactIds: [], contradictingArtifactIds: [], independenceGroups: [], status: 'hypothesis', confidence: 'low', rationale: 'Первое ребро.' });
  const second = createManualRelationship({ personAId: parent.id, relationshipType: 'parent', personBId: child.id, basis: 'unknown', claimIds: [], supportingArtifactIds: [], contradictingArtifactIds: [], independenceGroups: [], status: 'hypothesis', confidence: 'low', rationale: 'Второе ребро.' });
  assert.equal(first.relationshipType, 'parent');
  assert.equal(second.relationshipType, 'parent');
  assert.equal(getResearchCase().relationships.length, 2);
});

test('removing and re-adding a tree relationship preserves the contradicted history', () => {
  const people: Person[] = [
    { id: 'tree-parent', name: 'Родитель Тестов', provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'tree-child', name: 'Ребёнок Тестов', provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  captureConversationArtifacts([{ id: 'm-relation-1', text: 'Это родитель и ребёнок.' }]);
  const firstRelation = { id: 'tree-relation-1', type: 'parent' as const, fromId: people[0].id, toId: people[1].id, provenance: 'told' as const };
  const firstEvidence = recordTreeRelationship(firstRelation, people);
  recordRelationshipRemoval(firstRelation);

  captureConversationArtifacts([{ id: 'm-relation-2', text: 'Я снова добавляю эту связь.' }]);
  const secondRelation = { ...firstRelation, id: 'tree-relation-2' };
  const secondEvidence = recordTreeRelationship(secondRelation, people);
  const researchCase = getResearchCase();

  assert.notEqual(firstEvidence.id, secondEvidence.id);
  assert.equal(researchCase.relationships.length, 2);
  assert.equal(researchCase.relationships[0].status, 'contradicted');
  assert.equal(researchCase.relationships[1].status, 'single-source');
  assert.equal(researchCase.relationships[1].treeRelationId, 'tree-relation-2');
  assert.equal(researchCase.claims.filter(item => item.claimType === 'relationship:parent').length, 2);
  assert.deepEqual(auditEvidence().errors, []);
});

test('a relationship involving a hypothetical placeholder cannot be promoted by a tool argument', () => {
  assert.equal(evidenceSafeRelationProvenance(['told', 'hypothesis'], 'told'), 'hypothesis');
  assert.equal(evidenceSafeRelationProvenance(['told', 'hypothesis'], 'document'), 'hypothesis');
  assert.equal(evidenceSafeRelationProvenance(['document', 'document'], 'document'), 'document');
});

test('document provenance cannot exist without a source reference', () => {
  assert.throws(() => requireDocumentSource('document'), /ссылка или архивный шифр/);
  assert.throws(() => requireDocumentSource('document', 'какой-то документ'), /ссылка или архивный шифр/);
  assert.doesNotThrow(() => requireDocumentSource('document', 'ГАРФ, ф. 1, оп. 2, д. 3'));
  assert.doesNotThrow(() => requireDocumentSource('document', 'https://archive.example/record/17'));
  assert.doesNotThrow(() => requireDocumentSource('told'));
});

test('CAPTCHA is logged as a blocker with zero attempts', () => {
  const search = registerSearchAttempt({
    targetPersonIds: [], researchGoal: 'Открыть карточку', query: 'Иван Соколов', sourceOrDomain: 'example.test', filters: {},
    resultStatus: 'blocked', artifactIds: [], blocker: 'CAPTCHA', coverageNotes: 'Карточка не просмотрена.', nextStep: 'Передать URL человеку.',
  });
  assert.equal(search.captchaAttempts, 0);
  assert.equal(auditEvidence().errors.length, 0);
});

test('negative search without coverage is warned and never treated as proof', () => {
  registerSearchAttempt({
    targetPersonIds: [], researchGoal: 'Поиск рождения', query: 'Иван Соколов', sourceOrDomain: 'archive.test', filters: {},
    resultStatus: 'not-found-in-scope', artifactIds: [], nextStep: 'Проверить неиндексированные книги.',
  });
  assert.match(auditEvidence().warnings.join('\n'), /без описания просмотренного объёма/);
});

test('OBD record creates an unmerged candidate, artifact and atomic field claims', () => {
  const recorded = recordObdRecord({
    source: 'ОБД «Мемориал»',
    url: 'https://obd-memorial.ru/html/info.htm?id=123456',
    fields: { Фамилия: 'Соколов', Имя: 'Иван', Отчество: 'Петрович', 'Дата рождения/Возраст': '1902', 'Место рождения': 'д. Новая', 'Дата выбытия': '12.03.1943' },
  });
  assert.equal(recorded.person.treePersonId, undefined);
  assert.equal(recorded.person.candidateStatus, 'candidate');
  assert.equal(recorded.artifact.independenceGroup, 'OBD-CARD-123456');
  assert.equal(recorded.claims.length, 6);
  assert.ok(recorded.claims.every(item => item.status === 'single-source'));
  const retried = recordObdRecord({ source: 'ОБД «Мемориал»', url: 'https://obd-memorial.ru/html/info.htm?id=123456', fields: { Фамилия: 'Соколов', Имя: 'Иван', Отчество: 'Петрович', 'Дата рождения/Возраст': '1902', 'Место рождения': 'д. Новая', 'Дата выбытия': '12.03.1943' } });
  assert.equal(retried.artifact.id, recorded.artifact.id);
  assert.equal(getResearchCase().artifacts.length, 1);
});

test('OBD search records exact query scope and treats zero results as scoped only', () => {
  const result = {
    source: 'ОБД «Мемориал»', query: 'Соколов Иван, 1902 г. р.', searchUrl: 'https://obd-memorial.ru/html/search.htm?f=Соколов&n=Иван&y=1902',
    total: 0, searched: 0, shown: [], note: 'Всего в базе 0, просмотрено 0.',
  };
  const filters = { lastName: 'Соколов', firstName: 'Иван', birthYear: '1902' };
  const attempt = recordObdSearch(result, filters);
  recordObdSearch(result, filters);
  assert.equal(attempt.resultStatus, 'not-found-in-scope');
  assert.equal(attempt.resultCount, 0);
  assert.match(attempt.coverageNotes ?? '', /не доказывает отсутствие/);
  assert.equal(getResearchCase().artifacts[0]?.directness, 'lead-only');
  assert.equal(getResearchCase().artifacts.length, 1);
  assert.equal(getResearchCase().searches.length, 2);
});

test('confirmed candidate identity merges into an existing tree-backed person without losing evidence', () => {
  const treePerson: Person = { id: 'tree-1', name: 'Иван Соколов', provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' };
  recordTreePerson(treePerson);
  const candidate = createManualCandidate({ label: 'Иван П. Соколов', namesAsWritten: ['Иван П. Соколов'] });
  const source = createManualArtifact({
    sourceTitle: 'Архивная карточка', sourceType: 'archive-card', repositoryOrArchive: 'ЦАМО', archivalReference: 'ф. 1, оп. 2, д. 3',
    personIds: [candidate.id], namesAsWritten: ['Иван П. Соколов'], summary: 'Карточка кандидата.', provenanceLevel: 'known', directness: 'direct',
    originality: 'image-of-original', legibility: 'clear',
  });
  const claim = createManualClaim({
    claimText: 'В карточке указан 1902 год.', subjectPersonIds: [candidate.id], claimType: 'birth-date', artifactIds: [source.id],
    supportingIndependenceGroups: [], contradictingArtifactIds: [], contradictsClaimIds: [], status: 'single-source', confidence: 'moderate', rationale: 'Одна карточка.',
  });
  const weakConfirmation = captureConversationArtifacts([{ id: 'm-no', text: 'Пока не уверен.' }])[0];
  assert.throws(() => linkCandidateToTreePerson(candidate.id, 'tree-1', 'Совпадают дата и место.', weakConfirmation.id), /явное подтверждение/);
  const confirmation = captureConversationArtifacts([{ id: 'm-yes', text: 'Подтверждаю: это тот же человек.' }])[0];
  const linked = linkCandidateToTreePerson(candidate.id, 'tree-1', 'Совпадают точная дата рождения, место и имя жены.', confirmation.id);
  const researchCase = getResearchCase();
  assert.equal(linked.treePersonId, 'tree-1');
  assert.equal(researchCase.people.length, 1);
  assert.deepEqual(researchCase.artifacts.find(item => item.id === source.id)?.personIds, [linked.id]);
  assert.deepEqual(researchCase.claims.find(item => item.id === claim.id)?.subjectPersonIds, [linked.id]);
});

test('manual artifacts cannot manufacture independent provenance groups', () => {
  const person = createManualCandidate({ label: 'Мария', namesAsWritten: ['Мария'] });
  const one = artifact('Копия один', 'FAKE-A');
  const two = artifact('Копия два', 'FAKE-B');
  assert.equal(one.independenceGroup, 'MANUAL-LINEAGE-UNVERIFIED');
  assert.equal(two.independenceGroup, one.independenceGroup);
  assert.throws(() => createManualClaim({
    claimText: 'Мария родилась в 1901 году.', subjectPersonIds: [person.id], claimType: 'birth-date', artifactIds: [one.id, two.id],
    supportingIndependenceGroups: [], contradictingArtifactIds: [], contradictsClaimIds: [], status: 'corroborated', confidence: 'high', rationale: 'Две копии.',
  }), /две независимые группы/);
});

test('search attempts reject unknown evidence references', () => {
  assert.throws(() => registerSearchAttempt({
    targetPersonIds: ['missing'], researchGoal: 'Проверка', query: 'Запрос', sourceOrDomain: 'example.test', filters: {},
    resultStatus: 'incomplete', artifactIds: [],
  }), /Неизвестный target person id/);
});

test('OBD parser never converts an unrecognized or half-loaded page into a negative result', () => {
  assert.deepEqual(interpretObdSearchPage(null, 'По Вашему запросу ничего не найдено', []), { total: 0, rows: [] });
  assert.throws(() => interpretObdSearchPage(null, 'Сервис временно недоступен', []), /не удалось подтвердить/i);
  assert.throws(() => interpretObdSearchPage(null, 'Результаты', [{ id: '1', name: 'Иван', birth: '', out: '', place: '', kind: '' }]), /без счётчика/);
});

test('automatic searches reject people born after the privacy cutoff', () => {
  assert.doesNotThrow(() => assertSearchSubjectEligible({ birthYear: 1930 }));
  assert.throws(() => assertSearchSubjectEligible({ birthYear: 1931 }), /позже 1930/);
});

test('reconciliation preserves history and restores projection links in both undo directions', () => {
  const tree: Tree = {
    people: [
      { id: 'p1', name: 'Мария', provenance: 'told', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'p2', name: 'Анна', provenance: 'told', createdAt: '2020-01-01T00:00:00.000Z' },
    ],
    relations: [{ id: 'r1', type: 'parent', fromId: 'p1', toId: 'p2', provenance: 'told' }],
  };
  backfillTreeEvidence(tree);
  reconcileResearchWithTree({ people: [], relations: [] });
  assert.ok(getResearchCase().people.every(item => item.treePersonId === undefined));
  assert.equal(getResearchCase().relationships[0].status, 'contradicted');
  reconcileResearchWithTree(tree);
  const restored = getResearchCase();
  assert.deepEqual(restored.people.map(item => item.treePersonId).sort(), ['p1', 'p2']);
  assert.equal(restored.relationships.length, 1);
  assert.equal(restored.relationships[0].status, 'single-source');
  assert.deepEqual(auditEvidence(restored, tree).errors, []);
});

test('structural audit detects stale links against the current tree projection', () => {
  const person: Person = { id: 'tree-stale', name: 'Синтетический человек', provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' };
  recordTreePerson(person);
  assert.match(auditEvidence(getResearchCase(), { people: [], relations: [] }).errors.join('\n'), /отсутствующего человека древа/);
});

test('partial tree updates only source the fields asserted in that message', () => {
  const person: Person = { id: 'tree-delta', name: 'Иван', birth: { year: 1902 }, provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' };
  captureConversationArtifacts([{ id: 'm-birth', text: 'Иван родился в 1902 году.' }]);
  recordTreePerson(person);
  captureConversationArtifacts([{ id: 'm-job', text: 'Иван был плотником.' }]);
  recordTreePerson({ ...person, note: 'Плотник.' }, ['biographical-note']);
  const claims = getResearchCase().claims;
  assert.equal(claims.filter(item => item.claimType === 'birth-date').length, 1);
  assert.equal(claims.filter(item => item.claimType === 'name').length, 1);
  assert.equal(claims.filter(item => item.claimType === 'biographical-note').length, 1);
});

test('tree projection cannot downgrade a corroborated research relationship', () => {
  const people: Person[] = [
    { id: 'a', name: 'Мария', provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', name: 'Анна', provenance: 'told', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  people.forEach(person => recordTreePerson(person));
  const [a, b] = getResearchCase().people;
  const first = createManualArtifact({ sourceTitle: 'Акт 1', sourceType: 'record', repositoryOrArchive: 'Архив', archivalReference: 'ф. 1, оп. 1, д. 1', personIds: [a.id, b.id], namesAsWritten: [], summary: 'Акт.', provenanceLevel: 'known', directness: 'direct', originality: 'original', legibility: 'clear' });
  const second = createManualArtifact({ sourceTitle: 'Акт 2', sourceType: 'record', repositoryOrArchive: 'Архив', archivalReference: 'ф. 2, оп. 2, д. 2', personIds: [a.id, b.id], namesAsWritten: [], summary: 'Другой акт.', provenanceLevel: 'known', directness: 'direct', originality: 'original', legibility: 'clear' });
  const canonical = createManualRelationship({ personAId: a.id, relationshipType: 'parent', personBId: b.id, basis: 'biological', claimIds: [], supportingArtifactIds: [first.id, second.id], contradictingArtifactIds: [], independenceGroups: [], status: 'corroborated', confidence: 'high', rationale: 'Два независимых акта.' });
  recordTreeRelationship({ id: 'tree-edge', type: 'parent', fromId: 'a', toId: 'b', provenance: 'told' }, people);
  assert.equal(getResearchCase().relationships.find(item => item.id === canonical.id)?.status, 'corroborated');
});

test('legacy tree is preserved while evidence is backfilled', () => {
  const tree: Tree = {
    people: [
      { id: 'p1', name: 'Мария', provenance: 'told', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'p2', name: 'Анна', provenance: 'hypothesis', createdAt: '2020-01-01T00:00:00.000Z' },
    ],
    relations: [{ id: 'r1', type: 'parent', fromId: 'p1', toId: 'p2', provenance: 'hypothesis' }],
  };
  const before = structuredClone(tree);
  backfillTreeEvidence(tree);
  backfillTreeEvidence(tree);
  assert.deepEqual(tree, before);
  const researchCase = getResearchCase();
  assert.equal(researchCase.people.length, 2);
  assert.equal(researchCase.relationships.length, 1);
  assert.equal(researchCase.people.find(item => item.treePersonId === 'p2')?.candidateStatus, 'identified');
});

test('legacy tree.json without history remains readable and corrupt data is not silently erased', () => {
  const legacy = { people: [{ id: 'p1', name: 'Мария', provenance: 'told', createdAt: '2020-01-01T00:00:00.000Z' }], relations: [] };
  fs.writeFileSync(path.join(testDataDir, 'tree.json'), JSON.stringify(legacy));
  assert.equal(getTree().people[0]?.name, 'Мария');
  assert.equal(getTree().canUndo, false);
  fs.writeFileSync(path.join(testDataDir, 'tree.json'), '{broken json');
  assert.throws(() => getTree(), /JSON/);
});

test('tree mutations remain undoable with the evidence store enabled', () => {
  change('Синтетическая проверка', tree => tree.people.push({
    id: 'synthetic-person',
    name: 'Тестовый Человек',
    provenance: 'told',
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  assert.equal(getTree().people.length, 1);
  assert.equal(getTree().canUndo, true);
  undo();
  assert.equal(getTree().people.length, 0);
  assert.equal(getTree().canUndo, false);
});

test('cross-file transaction restores both stores after a failed coordinated write', () => {
  assert.throws(() => withPersistenceTransaction(() => {
    change('Не должно сохраниться', tree => tree.people.push({
      id: 'rollback-person', name: 'Откат', provenance: 'hypothesis', createdAt: '2026-01-01T00:00:00.000Z',
    }));
    updateResearchScope({ researchQuestion: 'Не должно сохраниться' });
    throw new Error('synthetic failure');
  }), /synthetic failure/);
  assert.equal(getTree().people.length, 0);
  assert.equal(getResearchCase().researchQuestion, undefined);
});

test('vendored skill contains the pinned methodology, license and update metadata', () => {
  const vendor = new URL('../vendor/ex-ussr-kinship-research/', import.meta.url);
  for (const relative of ['SKILL.md', 'LICENSE', 'UPSTREAM.md', 'evals/discovery-and-logic.yaml', 'references/evidence-protocol.md']) {
    assert.equal(fs.existsSync(new URL(relative, vendor)), true, `missing vendored ${relative}`);
  }
  const upstream = fs.readFileSync(new URL('UPSTREAM.md', vendor), 'utf8');
  assert.match(upstream, /5a430a2e8eb11ccf45ef8ed8e49c6abb8a1436d0/);
  assert.match(upstream, /To refresh it/);
});

test('instruction router loads only relevant modules and always keeps safety core', () => {
  assert.deepEqual(selectResearchModules('Открой FamilySearch фильм с метрическими сканами'), ['source-strategy.md', 'field-lessons.md']);
  const living = researchInstructionsFor('Найди телефон живого родственника');
  assert.match(living, /privacy-and-safety\.md/);
  assert.match(living, /Не ищи текущие контакты/);
  const unrelated = researchInstructionsFor('Привет');
  assert.equal(unrelated, RESEARCH_CORE);
  assert.doesNotMatch(unrelated, /seed-sources\.md/);
});

test('research report is reproducible and redacts living people by default', () => {
  const living = createManualCandidate({ label: 'Живой родственник', namesAsWritten: ['Живой родственник'], livingStatus: 'living' });
  updatePersonCandidate({ id: living.id, birthEstimate: '1988', placesAsWritten: ['Секретный город'] });
  const livingArtifact = createManualArtifact({
    sourceTitle: 'Документ Живого родственника', sourceUrlOrPath: 'https://example.test/private-living-record', sourceType: 'user-document',
    personIds: [living.id], namesAsWritten: ['Живой родственник'], summary: 'Личные сведения.', provenanceLevel: 'known', directness: 'direct',
    originality: 'image-of-original', independenceGroup: 'LIVING-PRIVATE-1', legibility: 'clear',
  });
  createManualClaim({
    claimText: 'Живой родственник живёт в Секретном городе.', subjectPersonIds: [living.id], claimType: 'residence', valueAsWritten: 'Секретный город',
    artifactIds: [livingArtifact.id], supportingIndependenceGroups: [], contradictingArtifactIds: [], contradictsClaimIds: [], status: 'single-source',
    confidence: 'moderate', rationale: 'Личный документ.',
  });
  const redacted = renderResearchReport();
  assert.doesNotMatch(redacted, /Живой родственник/);
  assert.doesNotMatch(redacted, /Секретный город/);
  assert.doesNotMatch(redacted, /private-living-record/);
  assert.match(redacted, new RegExp(living.id));
  const full = renderResearchReport({ redactLivingPeople: false });
  assert.match(full, /Живой родственник/);
  assert.match(full, /Секретный город/);
  assert.match(full, /private-living-record/);
  assert.match(full, /Аудит проверяет целостность, но не объявляет выводы истинными/);
});

test('redacted reports treat unknown living status as private', () => {
  const person = createManualCandidate({ label: 'Возможно живой человек', namesAsWritten: ['Возможно живой человек'] });
  const source = createManualArtifact({
    sourceTitle: 'Личная анкета Возможно живого человека', sourceUrlOrPath: 'https://example.test/possibly-living', sourceType: 'questionnaire',
    personIds: [person.id], namesAsWritten: ['Возможно живой человек'], summary: 'Неизвестно, жив ли человек.', provenanceLevel: 'known', directness: 'direct',
    originality: 'user-statement', legibility: 'clear',
  });
  const report = renderResearchReport();
  assert.doesNotMatch(report, /Возможно живой человек/);
  assert.doesNotMatch(report, /possibly-living/);
  assert.match(report, /скрыто/);
  assert.ok(source.id);
});

function artifact(title: string, independenceGroup: string): ResearchArtifact {
  return createManualArtifact({
    sourceTitle: title,
    sourceType: 'index',
    personIds: [],
    namesAsWritten: [],
    summary: title,
    provenanceLevel: 'known',
    directness: 'direct',
    originality: 'index',
    independenceGroup,
    legibility: 'clear',
  });
}
