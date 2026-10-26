import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  EvidenceAudit,
  EvidenceConfidence,
  EvidenceStatus,
  Person,
  Provenance,
  Relation,
  ResearchArtifact,
  ResearchCase,
  ResearchClaim,
  ResearchPerson,
  ResearchRelationship,
  SearchAttempt,
  SearchResult,
  SearchResultStatus,
  Tree,
} from '../shared/types.js';

const CASE_ID = 'default';
export type ResearchStoreSnapshot = { exists: boolean; content?: string };
const CORROBORATED = new Set<EvidenceStatus>(['corroborated', 'strongly-corroborated']);
const VALID_STATUSES = new Set<EvidenceStatus>([
  'hypothesis',
  'single-source',
  'corroborated',
  'strongly-corroborated',
  'contradicted',
  'unresolved',
]);

function now(): string {
  return new Date().toISOString();
}

function nextId(prefix: 'P' | 'A' | 'C' | 'R' | 'S'): string {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

function caseFile(): string {
  return path.join(path.resolve(process.env.DATA_DIR ?? 'data'), 'research-case.json');
}

export function emptyResearchCase(createdAt = now()): ResearchCase {
  return {
    schemaVersion: 1,
    id: CASE_ID,
    createdAt,
    updatedAt: createdAt,
    requestedOutputLanguage: 'auto',
    scope: {
      geographicScope: [],
      allowedSources: [],
      prohibitedSources: [],
      paidSourcesAllowed: false,
      thirdPartyUploadAllowed: false,
      contactWithPeopleOrArchivesAllowed: false,
    },
    privacy: {
      redactLivingPeopleInSharedReport: true,
      excludeCurrentContactsAndAddresses: true,
      sensitiveTopics: [],
    },
    people: [],
    artifacts: [],
    claims: [],
    relationships: [],
    searches: [],
  };
}

function parseCase(value: unknown): ResearchCase {
  if (!value || typeof value !== 'object') throw new Error('Файл исследовательского дела повреждён: ожидался объект.');
  const candidate = value as Partial<ResearchCase>;
  if (candidate.schemaVersion !== 1) throw new Error(`Неподдерживаемая версия исследовательского дела: ${String(candidate.schemaVersion)}.`);
  for (const key of ['people', 'artifacts', 'claims', 'relationships', 'searches'] as const) {
    if (!Array.isArray(candidate[key])) throw new Error(`Файл исследовательского дела повреждён: поле ${key} не является списком.`);
  }
  return candidate as ResearchCase;
}

function read(): ResearchCase {
  try {
    return parseCase(JSON.parse(fs.readFileSync(caseFile(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyResearchCase();
    throw error;
  }
}

function write(researchCase: ResearchCase): void {
  const file = caseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(researchCase, null, 2));
  fs.renameSync(temp, file);
}

export function snapshotResearchStore(): ResearchStoreSnapshot {
  const file = caseFile();
  try {
    return { exists: true, content: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

export function restoreResearchStore(snapshotValue: ResearchStoreSnapshot): void {
  const file = caseFile();
  if (!snapshotValue.exists) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.restore.tmp`;
  fs.writeFileSync(temp, snapshotValue.content ?? '');
  fs.renameSync(temp, file);
}

function mutate<T>(change: (draft: ResearchCase) => T): T {
  const draft = structuredClone(read());
  const result = change(draft);
  draft.updatedAt = now();
  write(draft);
  return result;
}

export function getResearchCase(): ResearchCase {
  return structuredClone(read());
}

export function updateResearchScope(input: {
  researchQuestion?: string;
  requestedOutputLanguage?: string;
  targetRelationship?: string;
  timeRange?: string;
  geographicScope?: string[];
  allowedSources?: string[];
  prohibitedSources?: string[];
  paidSourcesAllowed?: boolean;
  thirdPartyUploadAllowed?: boolean;
  contactWithPeopleOrArchivesAllowed?: boolean;
  sensitiveTopics?: string[];
}): ResearchCase {
  return mutate(draft => {
    if (input.researchQuestion !== undefined) draft.researchQuestion = input.researchQuestion.trim() || undefined;
    if (input.requestedOutputLanguage !== undefined) draft.requestedOutputLanguage = input.requestedOutputLanguage.trim() || 'auto';
    if (input.targetRelationship !== undefined) draft.scope.targetRelationship = input.targetRelationship.trim() || undefined;
    if (input.timeRange !== undefined) draft.scope.timeRange = input.timeRange.trim() || undefined;
    if (input.geographicScope !== undefined) draft.scope.geographicScope = uniqueStrings(input.geographicScope);
    if (input.allowedSources !== undefined) draft.scope.allowedSources = uniqueStrings(input.allowedSources);
    if (input.prohibitedSources !== undefined) draft.scope.prohibitedSources = uniqueStrings(input.prohibitedSources);
    if (input.paidSourcesAllowed !== undefined) draft.scope.paidSourcesAllowed = input.paidSourcesAllowed;
    if (input.thirdPartyUploadAllowed !== undefined) draft.scope.thirdPartyUploadAllowed = input.thirdPartyUploadAllowed;
    if (input.contactWithPeopleOrArchivesAllowed !== undefined) draft.scope.contactWithPeopleOrArchivesAllowed = input.contactWithPeopleOrArchivesAllowed;
    if (input.sensitiveTopics !== undefined) draft.privacy.sensitiveTopics = uniqueStrings(input.sensitiveTopics);
    return draft;
  });
}

export function captureConversationArtifact(messageId: string, text: string, informantId = 'current-user'): ResearchArtifact | null {
  const content = text.trim();
  if (!messageId || !content) return null;
  return mutate(draft => {
    const stableKey = `conversation:user:${messageId}`;
    const existing = draft.artifacts.find(item => item.stableKey === stableKey);
    if (existing) return existing;
    const artifact: ResearchArtifact = {
      id: nextId('A'),
      stableKey,
      capturedAt: now(),
      sourceTitle: 'Сообщение пользователя',
      sourceType: 'user-statement',
      personIds: [],
      namesAsWritten: [],
      summary: content.slice(0, 4_000),
      provenanceLevel: 'known',
      directness: 'direct',
      originality: 'user-statement',
      independenceGroup: `USER-INFORMANT-${stableHash(informantId)}`,
      legibility: 'clear',
      relatedClaimIds: [],
      status: 'captured',
    };
    draft.artifacts.push(artifact);
    return artifact;
  });
}

export function captureConversationArtifacts(messages: { id: string; text: string; informantId?: string }[]): ResearchArtifact[] {
  const usable = messages.map(item => ({ id: item.id, text: item.text.trim(), informantId: item.informantId ?? 'current-user' })).filter(item => item.id && item.text);
  if (usable.length === 0) return [];
  return mutate(draft => {
    const captured: ResearchArtifact[] = [];
    for (const message of usable) {
      const stableKey = `conversation:user:${message.id}`;
      const existing = draft.artifacts.find(item => item.stableKey === stableKey);
      if (existing) {
        captured.push(existing);
        continue;
      }
      const artifact: ResearchArtifact = {
        id: nextId('A'),
        stableKey,
        capturedAt: now(),
        sourceTitle: 'Сообщение пользователя',
        sourceType: 'user-statement',
        personIds: [],
        namesAsWritten: [],
        summary: message.text.slice(0, 4_000),
        provenanceLevel: 'known',
        directness: 'direct',
        originality: 'user-statement',
        independenceGroup: `USER-INFORMANT-${stableHash(message.informantId)}`,
        legibility: 'clear',
        relatedClaimIds: [],
        status: 'captured',
      };
      draft.artifacts.push(artifact);
      captured.push(artifact);
    }
    return captured;
  });
}

export function latestUserArtifactId(researchCase = read()): string | undefined {
  return researchCase.artifacts.filter(item => item.sourceType === 'user-statement').at(-1)?.id;
}

function ensureTreePerson(draft: ResearchCase, person: Person): ResearchPerson {
  const timestamp = now();
  let candidate = draft.people.find(item => item.treePersonId === person.id);
  if (!candidate) {
    candidate = {
      id: nextId('P'),
      treePersonId: person.id,
      preferredLabel: person.name,
      livingStatus: person.death ? 'deceased' : 'unknown',
      names: [{ asWritten: person.name, normalized: person.name }],
      birthEstimate: person.birth?.year ? `${person.birth.approximate ? 'около ' : ''}${person.birth.year}` : undefined,
      deathEstimate: person.death?.year ? `${person.death.approximate ? 'около ' : ''}${person.death.year}` : undefined,
      placesAsWritten: [...new Set([person.birth?.place, person.death?.place].filter((item): item is string => Boolean(item)))],
      historicalJurisdictions: [],
      candidateStatus: 'identified',
      sourceArtifactIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      notes: person.note,
    };
    draft.people.push(candidate);
  } else {
    candidate.preferredLabel = person.name;
    if (!candidate.names.some(item => item.asWritten === person.name)) candidate.names.push({ asWritten: person.name, normalized: person.name });
    candidate.birthEstimate = person.birth?.year ? `${person.birth.approximate ? 'около ' : ''}${person.birth.year}` : candidate.birthEstimate;
    candidate.deathEstimate = person.death?.year ? `${person.death.approximate ? 'около ' : ''}${person.death.year}` : candidate.deathEstimate;
    for (const place of [person.birth?.place, person.death?.place]) {
      if (place && !candidate.placesAsWritten.includes(place)) candidate.placesAsWritten.push(place);
    }
    if (person.death) candidate.livingStatus = 'deceased';
    if (person.note) candidate.notes = person.note;
    candidate.updatedAt = timestamp;
  }
  return candidate;
}

function sourceArtifactForTreeChange(draft: ResearchCase, person: Person, provenance: Provenance): ResearchArtifact {
  if (provenance !== 'hypothesis') {
    const latestId = latestUserArtifactId(draft);
    const latest = latestId ? draft.artifacts.find(item => item.id === latestId) : undefined;
    if (provenance === 'told' && latest) return latest;
  }
  if (provenance === 'document' && person.source) {
    const stableKey = `document-reference:${person.source}`;
    const existing = draft.artifacts.find(item => item.stableKey === stableKey);
    if (existing) return existing;
    const artifact: ResearchArtifact = {
      id: nextId('A'),
      stableKey,
      capturedAt: now(),
      sourceTitle: 'Документ, указанный в древе',
      sourceUrlOrPath: person.source,
      sourceType: 'document-reference',
      personIds: [],
      namesAsWritten: [person.name],
      summary: person.note ?? `Источник сведений о ${person.name}`,
      provenanceLevel: 'partial',
      directness: 'direct',
      originality: 'unknown',
      independenceGroup: `DOCUMENT-${stableHash(person.source)}`,
      legibility: 'not-applicable',
      relatedClaimIds: [],
      reliabilityNotes: 'Ссылка зафиксирована, но тип и происхождение документа ещё не оценены.',
      status: 'captured',
    };
    draft.artifacts.push(artifact);
    return artifact;
  }
  const stableKey = `agent-inference:${person.id}:${person.name}:${person.note ?? ''}`;
  const existing = draft.artifacts.find(item => item.stableKey === stableKey);
  if (existing) return existing;
  const artifact: ResearchArtifact = {
    id: nextId('A'),
    stableKey,
    capturedAt: now(),
    sourceTitle: provenance === 'hypothesis' ? 'Вывод агента' : 'Изменение древа',
    sourceType: provenance === 'hypothesis' ? 'agent-inference' : 'tree-change',
    personIds: [],
    namesAsWritten: [person.name],
    summary: person.note ?? `Добавлены сведения о ${person.name}`,
    provenanceLevel: 'known',
    directness: provenance === 'hypothesis' ? 'indirect' : 'direct',
    originality: 'derivative',
    independenceGroup: provenance === 'hypothesis' ? `INFERENCE-${person.id}` : `TREE-${person.id}`,
    legibility: 'not-applicable',
    relatedClaimIds: [],
    status: 'captured',
  };
  draft.artifacts.push(artifact);
  return artifact;
}

function addClaim(
  draft: ResearchCase,
  input: Omit<ResearchClaim, 'id' | 'createdAt' | 'updatedAt'>,
  stableKey?: string,
): ResearchClaim {
  if (stableKey) {
    const existing = draft.claims.find(item => claimStableKey(item) === stableKey);
    if (existing) return existing;
  }
  const timestamp = now();
  const claim: ResearchClaim = { ...input, id: nextId('C'), createdAt: timestamp, updatedAt: timestamp };
  draft.claims.push(claim);
  for (const artifactId of claim.artifactIds) {
    const artifact = draft.artifacts.find(item => item.id === artifactId);
    if (artifact && !artifact.relatedClaimIds.includes(claim.id)) artifact.relatedClaimIds.push(claim.id);
  }
  return claim;
}

function claimStableKey(claim: ResearchClaim): string {
  return [claim.subjectPersonIds.join(';'), claim.claimType, claim.valueAsWritten ?? claim.claimText, claim.artifactIds.join(';')].join('|');
}

export function recordTreePerson(person: Person, fieldsToRecord?: string[]): ResearchPerson {
  return mutate(draft => {
    const candidate = ensureTreePerson(draft, person);
    const selected = fieldsToRecord ? new Set(fieldsToRecord) : null;
    if (selected?.size === 0) return candidate;
    const artifact = sourceArtifactForTreeChange(draft, person, person.provenance);
    if (!artifact.personIds.includes(candidate.id)) artifact.personIds.push(candidate.id);
    if (!candidate.sourceArtifactIds.includes(artifact.id)) candidate.sourceArtifactIds.push(artifact.id);
    const status: EvidenceStatus = person.provenance === 'hypothesis' ? 'hypothesis' : 'single-source';
    const confidence: EvidenceConfidence = person.provenance === 'hypothesis' ? 'low' : 'moderate';
    const fields: { key: string; type: string; text: string; asWritten?: string; normalized?: string }[] = [
      { key: 'name', type: 'name', text: `Имя человека: ${person.name}`, asWritten: person.name, normalized: person.name },
    ];
    if (person.birth?.year) fields.push({ key: 'birth-date', type: 'birth-date', text: `${person.name} родился${person.birth.approximate ? ' примерно' : ''} в ${person.birth.year} году`, asWritten: String(person.birth.year), normalized: String(person.birth.year) });
    if (person.birth?.place) fields.push({ key: 'birth-place', type: 'birth-place', text: `Место рождения ${person.name}: ${person.birth.place}`, asWritten: person.birth.place });
    if (person.death?.year) fields.push({ key: 'death-date', type: 'death-date', text: `${person.name} умер${person.death.approximate ? ' примерно' : ''} в ${person.death.year} году`, asWritten: String(person.death.year), normalized: String(person.death.year) });
    if (person.death?.place) fields.push({ key: 'death-place', type: 'death-place', text: `Место смерти ${person.name}: ${person.death.place}`, asWritten: person.death.place });
    if (person.note) fields.push({ key: 'biographical-note', type: 'biographical-note', text: person.note, asWritten: person.note });
    for (const field of fields.filter(item => !selected || selected.has(item.key))) {
      const input = {
        claimText: field.text,
        subjectPersonIds: [candidate.id],
        claimType: field.type,
        valueAsWritten: field.asWritten,
        normalizedValue: field.normalized,
        artifactIds: [artifact.id],
        supportingIndependenceGroups: [artifact.independenceGroup],
        contradictingArtifactIds: [],
        contradictsClaimIds: [],
        status,
        confidence,
        rationale: person.provenance === 'hypothesis'
          ? 'Рабочая гипотеза агента; требуется независимый источник.'
          : person.provenance === 'document'
            ? 'Сведения связаны с одним указанным документом; происхождение документа оценивается отдельно.'
            : 'Сведения записаны со слов пользователя и пока имеют одну цепочку происхождения.',
      } satisfies Omit<ResearchClaim, 'id' | 'createdAt' | 'updatedAt'>;
      addClaim(draft, input, [candidate.id, field.type, field.asWritten ?? field.text, artifact.id].join('|'));
    }
    return candidate;
  });
}

export function recordTreeRelationship(relation: Relation, people: Person[]): ResearchRelationship {
  return mutate(draft => {
    const from = people.find(person => person.id === relation.fromId);
    const to = people.find(person => person.id === relation.toId);
    if (!from || !to) throw new Error('Нельзя записать доказательства связи: человек отсутствует в древе.');
    const personA = ensureTreePerson(draft, from);
    const personB = ensureTreePerson(draft, to);
    const artifact = sourceArtifactForTreeChange(
      draft,
      relation.source ? { ...from, source: relation.source } : from,
      relation.provenance,
    );
    for (const personId of [personA.id, personB.id]) if (!artifact.personIds.includes(personId)) artifact.personIds.push(personId);
    const status: EvidenceStatus = relation.provenance === 'hypothesis' ? 'hypothesis' : 'single-source';
    const timestamp = now();
    const claim = addClaim(draft, {
      claimText: relation.type === 'parent' ? `${from.name} — родитель ${to.name}` : `${from.name} и ${to.name} — супруги`,
      subjectPersonIds: [personA.id, personB.id],
      claimType: `relationship:${relation.type}`,
      valueAsWritten: personB.id,
      artifactIds: [artifact.id],
      supportingIndependenceGroups: [artifact.independenceGroup],
      contradictingArtifactIds: [],
      contradictsClaimIds: [],
      status,
      confidence: relation.provenance === 'hypothesis' ? 'low' : 'moderate',
      rationale: relation.provenance === 'hypothesis' ? 'Рабочая гипотеза; связь ещё не подтверждена документом.' : 'Связь происходит из одной цепочки.',
    }, [personA.id, `relationship:${relation.type}`, personB.id, artifact.id].join('|'));
    const existing = draft.relationships.find(item =>
      item.status !== 'contradicted'
      && (item.treeRelationId === relation.id || (
        !item.treeRelationId
        && item.personAId === personA.id
        && item.personBId === personB.id
        && item.relationshipType === relation.type
      )),
    );
    if (existing) {
      existing.treeRelationId = relation.id;
      if (!existing.claimIds.includes(claim.id)) existing.claimIds.push(claim.id);
      if (!existing.supportingArtifactIds.includes(artifact.id)) existing.supportingArtifactIds.push(artifact.id);
      if (!existing.independenceGroups.includes(artifact.independenceGroup)) existing.independenceGroups.push(artifact.independenceGroup);
      if (evidenceStatusRank(status) > evidenceStatusRank(existing.status)) {
        existing.status = status;
        existing.confidence = relation.provenance === 'hypothesis' ? 'low' : 'moderate';
      }
      existing.rationale = appendNote(existing.rationale, claim.rationale) ?? claim.rationale;
      existing.updatedAt = timestamp;
      return existing;
    }
    const researchRelationship: ResearchRelationship = {
      id: nextId('R'),
      treeRelationId: relation.id,
      personAId: personA.id,
      relationshipType: relation.type,
      personBId: personB.id,
      basis: 'unknown',
      claimIds: [claim.id],
      supportingArtifactIds: [artifact.id],
      contradictingArtifactIds: [],
      independenceGroups: [artifact.independenceGroup],
      status,
      confidence: relation.provenance === 'hypothesis' ? 'low' : 'moderate',
      rationale: claim.rationale,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    draft.relationships.push(researchRelationship);
    return researchRelationship;
  });
}

export function recordRelationshipRemoval(relation: Relation): void {
  mutate(draft => {
    const personA = draft.people.find(item => item.treePersonId === relation.fromId);
    const personB = draft.people.find(item => item.treePersonId === relation.toId);
    if (!personA || !personB) return;
    const evidence = draft.relationships.findLast(item =>
      item.status !== 'contradicted'
      && (item.treeRelationId === relation.id || (
        !item.treeRelationId
        && item.personAId === personA.id
        && item.personBId === personB.id
        && item.relationshipType === relation.type
      )),
    );
    if (!evidence) return;
    evidence.status = 'contradicted';
    evidence.confidence = 'high';
    evidence.rationale = 'Пользователь исправил или удалил эту связь в древе; прежняя версия сохранена как противоречащая.';
    evidence.updatedAt = now();
    for (const claimId of evidence.claimIds) {
      const claim = draft.claims.find(item => item.id === claimId);
      if (claim) {
        claim.status = 'contradicted';
        claim.rationale = evidence.rationale;
        claim.updatedAt = evidence.updatedAt;
      }
    }
  });
}

/** Non-destructive bridge for installations that already have a tree.json. */
export function backfillTreeEvidence(tree: Tree): void {
  const researchCase = read();
  const knownTreePeople = new Set(researchCase.people.map(item => item.treePersonId).filter(Boolean));
  for (const person of tree.people) {
    if (!knownTreePeople.has(person.id)) recordTreePerson(person);
  }
  const refreshed = read();
  for (const relation of tree.relations) {
    const personA = refreshed.people.find(item => item.treePersonId === relation.fromId);
    const personB = refreshed.people.find(item => item.treePersonId === relation.toId);
    const exists = personA && personB && refreshed.relationships.some(item =>
      item.status !== 'contradicted'
      && (item.treeRelationId === relation.id || (
        !item.treeRelationId
        && item.personAId === personA.id
        && item.personBId === personB.id
        && item.relationshipType === relation.type
      )),
    );
    if (!exists) recordTreeRelationship(relation, tree.people);
  }
}

export function registerSearchAttempt(input: Omit<SearchAttempt, 'id' | 'timestamp' | 'captchaAttempts'>): SearchAttempt {
  return mutate(draft => {
    const people = new Set(draft.people.map(item => item.id));
    const artifacts = new Set(draft.artifacts.map(item => item.id));
    for (const personId of input.targetPersonIds) if (!people.has(personId)) throw new Error(`Неизвестный target person id ${personId}.`);
    for (const artifactId of input.artifactIds) if (!artifacts.has(artifactId)) throw new Error(`Неизвестный artifact id ${artifactId}.`);
    const attempt: SearchAttempt = { ...input, id: nextId('S'), timestamp: now(), captchaAttempts: 0 };
    draft.searches.push(attempt);
    return attempt;
  });
}

export function recordObdSearch(result: SearchResult, filters: Record<string, string>): SearchAttempt {
  return mutate(draft => {
    const snapshotFingerprint = JSON.stringify({ searchUrl: result.searchUrl, total: result.total, searched: result.searched, shown: result.shown });
    const stableKey = `obd-search:${stableHash(snapshotFingerprint)}`;
    let artifact = draft.artifacts.find(item => item.stableKey === stableKey);
    if (!artifact) {
      artifact = {
        id: nextId('A'),
        stableKey,
        capturedAt: now(),
        sourceTitle: `Результаты поиска: ${result.source}`,
        sourceUrlOrPath: result.searchUrl,
        sourceType: 'search-results',
        personIds: [],
        namesAsWritten: result.shown.map(item => item.name),
        summary: result.note ?? `По запросу «${result.query}» показано ${result.shown.length} записей.`,
        rawFields: Object.fromEntries(result.shown.map((item, index) => [`${index + 1}:${item.name}`, [item.birth, item.event, item.place, item.url].filter(Boolean).join(' | ')])),
        provenanceLevel: 'known',
        directness: 'lead-only',
        originality: 'index',
        independenceGroup: `OBD-SEARCH-${stableHash(result.searchUrl)}`,
        legibility: 'clear',
        relatedClaimIds: [],
        reliabilityNotes: 'Поисковая выдача является наводкой. Для вывода нужно открыть исходную карточку и документ.',
        status: 'captured',
      };
      draft.artifacts.push(artifact);
    }
    const status: SearchResultStatus = result.total === 0 ? 'not-found-in-scope' : result.shown.length === 0 ? 'incomplete' : 'found';
    const attempt: SearchAttempt = {
      id: nextId('S'),
      timestamp: now(),
      targetPersonIds: [],
      researchGoal: 'Найти кандидатов в ОБД «Мемориал» и затем проверить карточки наиболее похожих записей.',
      query: result.query,
      languageLocale: 'ru-RU',
      sourceOrDomain: 'obd-memorial.ru',
      filters,
      resultStatus: status,
      artifactIds: [artifact.id],
      resultCount: result.total,
      searchedCount: result.searched ?? result.shown.length,
      coverageNotes: result.total === 0
        ? 'В выполненном запросе сайт не вернул записей. Это не доказывает отсутствие человека в других вариантах имени, фильтрах или коллекциях.'
        : result.note,
      captchaAttempts: 0,
      nextStep: result.shown.length ? 'Открыть 1–3 наиболее похожие карточки и сравнить идентификаторы.' : 'Уточнить имя, отчество, год, место рождения или выполнить поиск по вариантам.',
    };
    draft.searches.push(attempt);
    return attempt;
  });
}

export function recordObdRecord(record: { source: string; url: string; fields: Record<string, string> }): { artifact: ResearchArtifact; person: ResearchPerson; claims: ResearchClaim[] } {
  return mutate(draft => {
    const externalRecordId = record.url.match(/[?&]id=(\d+)/)?.[1];
    const stableKey = `obd-record:${externalRecordId ?? record.url}`;
    let artifact = draft.artifacts.find(item => item.stableKey === stableKey);
    if (!artifact) {
      const archive = [
        record.fields['Название источника донесения'],
        record.fields['Номер фонда источника информации'] && `ф. ${record.fields['Номер фонда источника информации']}`,
        record.fields['Номер описи источника информации'] && `оп. ${record.fields['Номер описи источника информации']}`,
        record.fields['Номер дела источника информации'] && `д. ${record.fields['Номер дела источника информации']}`,
      ].filter(Boolean).join(', ');
      const fullName = ['Фамилия', 'Имя', 'Отчество'].map(key => record.fields[key]).filter(Boolean).join(' ');
      artifact = {
        id: nextId('A'),
        stableKey,
        capturedAt: now(),
        sourceTitle: `${record.source}: ${fullName || 'карточка записи'}`,
        sourceUrlOrPath: record.url,
        sourceType: 'military-record-card',
        repositoryOrArchive: record.fields['Название источника донесения'] || 'ОБД «Мемориал»',
        archivalReference: archive || undefined,
        externalRecordId,
        recordDateAsWritten: record.fields['Дата выбытия'] || record.fields['Дата рождения/Возраст'],
        placeAsWritten: record.fields['Место рождения'] || record.fields['Место призыва'],
        languageScript: 'ru-Cyrl',
        personIds: [],
        namesAsWritten: fullName ? [fullName] : [],
        summary: Object.entries(record.fields).slice(0, 12).map(([key, value]) => `${key}: ${value}`).join('; '),
        rawFields: record.fields,
        provenanceLevel: archive ? 'known' : 'partial',
        directness: 'direct',
        originality: 'index',
        independenceGroup: `OBD-CARD-${externalRecordId ?? stableHash(record.url)}`,
        legibility: 'clear',
        relatedClaimIds: [],
        reliabilityNotes: 'Карточка базы может быть индексом или описанием документа. Поля оцениваются отдельно; образ первичного документа предпочтительнее.',
        status: 'captured',
      };
      draft.artifacts.push(artifact);
    }

    let person = draft.people.find(item => item.sourceArtifactIds.includes(artifact.id));
    if (!person) {
      const fullName = artifact.namesAsWritten[0] ?? 'Неустановленный кандидат';
      const timestamp = now();
      person = {
        id: nextId('P'),
        preferredLabel: fullName,
        livingStatus: record.fields['Дата выбытия'] ? 'deceased' : 'unknown',
        names: [{ asWritten: fullName, normalized: fullName, languageScript: 'ru-Cyrl' }],
        birthEstimate: record.fields['Дата рождения/Возраст'] || record.fields['Дата рождения'],
        deathEstimate: record.fields['Дата выбытия'],
        placesAsWritten: [...new Set([record.fields['Место рождения'], record.fields['Место призыва'], record.fields['Первичное место захоронения']].filter((item): item is string => Boolean(item)))],
        historicalJurisdictions: [],
        candidateStatus: 'candidate',
        sourceArtifactIds: [artifact.id],
        createdAt: timestamp,
        updatedAt: timestamp,
        notes: 'Кандидат из внешней записи; не объединён с человеком в древе.',
      };
      draft.people.push(person);
    }
    if (!artifact.personIds.includes(person.id)) artifact.personIds.push(person.id);

    const claims: ResearchClaim[] = [];
    for (const [field, value] of Object.entries(record.fields)) {
      const clean = value.trim();
      if (!clean) continue;
      const claim = addClaim(draft, {
        claimText: `В карточке ${record.source} поле «${field}» содержит: ${clean}`,
        subjectPersonIds: [person.id],
        claimType: `source-field:${slug(field)}`,
        valueAsWritten: clean,
        artifactIds: [artifact.id],
        supportingIndependenceGroups: [artifact.independenceGroup],
        contradictingArtifactIds: [],
        contradictsClaimIds: [],
        status: 'single-source',
        confidence: artifact.provenanceLevel === 'known' ? 'moderate' : 'low',
        rationale: 'Поле извлечено из одной карточки ОБД. Оно описывает кандидата и не подтверждает тождество с человеком из семейного древа.',
        nextAction: 'Сверить образ документа, место, год, родственника и адрес с независимыми семейными или архивными материалами.',
      }, [person.id, `source-field:${slug(field)}`, clean, artifact.id].join('|'));
      claims.push(claim);
    }
    artifact.status = 'analyzed';
    return { artifact, person, claims };
  });
}

export function createManualCandidate(input: { label: string; namesAsWritten: string[]; livingStatus?: ResearchPerson['livingStatus']; rationale?: string }): ResearchPerson {
  return mutate(draft => {
    const timestamp = now();
    const person: ResearchPerson = {
      id: nextId('P'),
      preferredLabel: input.label,
      livingStatus: input.livingStatus ?? 'unknown',
      names: input.namesAsWritten.map(name => ({ asWritten: name })),
      placesAsWritten: [],
      historicalJurisdictions: [],
      candidateStatus: 'candidate',
      mergeOrSplitRationale: input.rationale,
      sourceArtifactIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    draft.people.push(person);
    return person;
  });
}

export function updatePersonCandidate(input: {
  id: string;
  preferredLabel?: string;
  livingStatus?: ResearchPerson['livingStatus'];
  namesAsWritten?: string[];
  birthEstimate?: string;
  deathEstimate?: string;
  placesAsWritten?: string[];
  historicalJurisdictions?: string[];
  candidateStatus?: ResearchPerson['candidateStatus'];
  mergeOrSplitRationale?: string;
  notes?: string;
}): ResearchPerson {
  return mutate(draft => {
    const person = draft.people.find(item => item.id === input.id);
    if (!person) throw new Error(`Неизвестный кандидат ${input.id}.`);
    if (input.preferredLabel !== undefined) person.preferredLabel = input.preferredLabel.trim() || person.preferredLabel;
    if (input.livingStatus !== undefined) person.livingStatus = input.livingStatus;
    if (input.namesAsWritten !== undefined) {
      for (const name of uniqueStrings(input.namesAsWritten)) if (!person.names.some(item => item.asWritten === name)) person.names.push({ asWritten: name });
    }
    if (input.birthEstimate !== undefined) person.birthEstimate = input.birthEstimate.trim() || undefined;
    if (input.deathEstimate !== undefined) person.deathEstimate = input.deathEstimate.trim() || undefined;
    if (input.placesAsWritten !== undefined) person.placesAsWritten = uniqueStrings(input.placesAsWritten);
    if (input.historicalJurisdictions !== undefined) person.historicalJurisdictions = uniqueStrings(input.historicalJurisdictions);
    if (input.candidateStatus !== undefined) person.candidateStatus = input.candidateStatus;
    if (input.mergeOrSplitRationale !== undefined) person.mergeOrSplitRationale = input.mergeOrSplitRationale.trim() || undefined;
    if (input.notes !== undefined) person.notes = input.notes.trim() || undefined;
    person.updatedAt = now();
    return person;
  });
}

type ManualArtifactInput = Omit<ResearchArtifact, 'id' | 'capturedAt' | 'relatedClaimIds' | 'status' | 'independenceGroup'> & { independenceGroup?: string };

export function createManualArtifact(input: ManualArtifactInput): ResearchArtifact {
  return mutate(draft => {
    if (input.stableKey) {
      const existing = draft.artifacts.find(item => item.stableKey === input.stableKey);
      if (existing) return existing;
    }
    for (const personId of input.personIds) if (!draft.people.some(item => item.id === personId)) throw new Error(`Неизвестный person id ${personId}.`);
    const artifact: ResearchArtifact = {
      ...input,
      independenceGroup: manualIndependenceGroup(input),
      id: nextId('A'),
      capturedAt: now(),
      relatedClaimIds: [],
      status: 'captured',
    };
    draft.artifacts.push(artifact);
    return artifact;
  });
}

export function createManualClaim(input: Omit<ResearchClaim, 'id' | 'createdAt' | 'updatedAt'>): ResearchClaim {
  return mutate(draft => {
    const supportingIndependenceGroups = [...new Set(input.artifactIds.map(id => draft.artifacts.find(item => item.id === id)?.independenceGroup).filter((item): item is string => Boolean(item)))];
    const normalized = { ...input, supportingIndependenceGroups };
    validateClaimReferences(draft, normalized);
    return addClaim(draft, normalized);
  });
}

export function createManualRelationship(input: Omit<ResearchRelationship, 'id' | 'createdAt' | 'updatedAt'>): ResearchRelationship {
  return mutate(draft => {
    const independenceGroups = [...new Set([
      ...input.supportingArtifactIds.map(id => draft.artifacts.find(item => item.id === id)?.independenceGroup).filter((item): item is string => Boolean(item)),
      ...input.claimIds.flatMap(id => draft.claims.find(item => item.id === id)?.supportingIndependenceGroups ?? []),
    ])];
    const normalized = { ...input, independenceGroups };
    validateRelationshipReferences(draft, normalized);
    const timestamp = now();
    const relationship: ResearchRelationship = { ...normalized, id: nextId('R'), createdAt: timestamp, updatedAt: timestamp };
    draft.relationships.push(relationship);
    return relationship;
  });
}

export function linkCandidateToTreePerson(candidateId: string, treePersonId: string, rationale: string, confirmationArtifactId: string): ResearchPerson {
  return mutate(draft => {
    const candidate = draft.people.find(item => item.id === candidateId);
    if (!candidate) throw new Error(`Неизвестный кандидат ${candidateId}.`);
    if (!rationale.trim()) throw new Error('Для объединения кандидата с древом нужно объяснение идентификации.');
    const latestUserArtifact = draft.artifacts.filter(item => item.sourceType === 'user-statement').at(-1);
    const confirmation = draft.artifacts.find(item => item.id === confirmationArtifactId);
    if (!confirmation || confirmation.id !== latestUserArtifact?.id || confirmation.sourceType !== 'user-statement' || !explicitIdentityConfirmation(confirmation.summary)) {
      throw new Error('Нужно явное подтверждение пользователя в последнем сообщении перед объединением кандидата с древом.');
    }
    const occupied = draft.people.find(item => item.treePersonId === treePersonId && item.id !== candidateId);
    if (occupied) {
      mergeResearchPeople(draft, candidate, occupied, rationale.trim());
      return occupied;
    }
    candidate.treePersonId = treePersonId;
    candidate.candidateStatus = 'identified';
    candidate.mergeOrSplitRationale = rationale.trim();
    candidate.updatedAt = now();
    return candidate;
  });
}

/** Reconcile projection links after tree undo, reset, or deletion without deleting research history. */
export function reconcileResearchWithTree(tree: Tree): void {
  mutate(draft => {
    const treePersonIds = new Set(tree.people.map(item => item.id));
    const treeRelationIds = new Set(tree.relations.map(item => item.id));
    const timestamp = now();
    for (const person of draft.people) {
      if (person.treePersonId && !treePersonIds.has(person.treePersonId)) {
        const formerTreeId = person.treePersonId;
        person.formerTreePersonId = formerTreeId;
        person.treePersonId = undefined;
        person.candidateStatus = 'candidate';
        person.mergeOrSplitRationale = appendNote(person.mergeOrSplitRationale, `Проекция ${formerTreeId} удалена или отменена; исследовательская история сохранена.`);
        person.updatedAt = timestamp;
      }
      if (!person.treePersonId && person.formerTreePersonId && treePersonIds.has(person.formerTreePersonId)) {
        person.treePersonId = person.formerTreePersonId;
        person.formerTreePersonId = undefined;
        person.candidateStatus = 'identified';
        person.updatedAt = timestamp;
      }
    }
    for (const relationship of draft.relationships) {
      if (relationship.treeRelationId && treeRelationIds.has(relationship.treeRelationId) && relationship.status === 'contradicted') {
        const treeRelation = tree.relations.find(item => item.id === relationship.treeRelationId);
        relationship.status = treeRelation?.provenance === 'hypothesis' ? 'hypothesis' : 'single-source';
        relationship.confidence = treeRelation?.provenance === 'hypothesis' ? 'low' : 'moderate';
        relationship.rationale = 'Связь восстановлена отменой последнего изменения в древе.';
        relationship.updatedAt = timestamp;
        for (const claimId of relationship.claimIds) {
          const claim = draft.claims.find(item => item.id === claimId);
          if (!claim) continue;
          claim.status = relationship.status;
          claim.confidence = relationship.confidence;
          claim.rationale = relationship.rationale;
          claim.updatedAt = timestamp;
        }
        continue;
      }
      if (!relationship.treeRelationId || treeRelationIds.has(relationship.treeRelationId) || relationship.status === 'contradicted') continue;
      relationship.status = 'contradicted';
      relationship.confidence = 'high';
      relationship.rationale = 'Связь удалена или отменена в компактном древе; прежняя версия сохранена как историческая.';
      relationship.updatedAt = timestamp;
      for (const claimId of relationship.claimIds) {
        const claim = draft.claims.find(item => item.id === claimId);
        if (!claim) continue;
        claim.status = 'contradicted';
        claim.rationale = relationship.rationale;
        claim.updatedAt = timestamp;
      }
    }
  });
  backfillTreeEvidence(tree);
}

export function auditEvidence(researchCase = read(), tree?: Tree): EvidenceAudit {
  const errors: string[] = [];
  const warnings: string[] = [];
  const personIds = new Set(researchCase.people.map(item => item.id));
  const artifactIds = new Set(researchCase.artifacts.map(item => item.id));
  const claimIds = new Set(researchCase.claims.map(item => item.id));
  const duplicates = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index);
  for (const [label, values] of [
    ['person', researchCase.people.map(item => item.id)],
    ['artifact', researchCase.artifacts.map(item => item.id)],
    ['claim', researchCase.claims.map(item => item.id)],
    ['relationship', researchCase.relationships.map(item => item.id)],
    ['search', researchCase.searches.map(item => item.id)],
  ] as const) {
    for (const duplicate of new Set(duplicates(values))) errors.push(`Дублирующийся ${label} id: ${duplicate}`);
  }
  for (const artifact of researchCase.artifacts) {
    if (!artifact.independenceGroup) warnings.push(`${artifact.id}: не указана группа независимости.`);
    for (const personId of artifact.personIds) if (!personIds.has(personId)) errors.push(`${artifact.id}: неизвестный person id ${personId}.`);
    for (const claimId of artifact.relatedClaimIds) if (!claimIds.has(claimId)) errors.push(`${artifact.id}: неизвестный claim id ${claimId}.`);
  }
  const treeLinks = researchCase.people.map(item => item.treePersonId).filter((item): item is string => Boolean(item));
  for (const duplicate of new Set(duplicates(treeLinks))) errors.push(`Несколько кандидатов связаны с одним tree person id: ${duplicate}`);
  const treeRelationLinks = researchCase.relationships.map(item => item.treeRelationId).filter((item): item is string => Boolean(item));
  for (const duplicate of new Set(duplicates(treeRelationLinks))) errors.push(`Несколько evidence-связей ссылаются на один tree relation id: ${duplicate}`);
  if (tree) {
    const actualTreePeople = new Set(tree.people.map(item => item.id));
    const actualTreeRelations = new Set(tree.relations.map(item => item.id));
    for (const person of researchCase.people) {
      if (person.treePersonId && !actualTreePeople.has(person.treePersonId)) errors.push(`${person.id}: ссылка на отсутствующего человека древа ${person.treePersonId}.`);
    }
    for (const relationship of researchCase.relationships) {
      if (relationship.treeRelationId && relationship.status !== 'contradicted' && !actualTreeRelations.has(relationship.treeRelationId)) {
        errors.push(`${relationship.id}: активная evidence-связь ссылается на отсутствующую связь древа ${relationship.treeRelationId}.`);
      }
    }
    for (const person of tree.people) {
      if (!researchCase.people.some(item => item.treePersonId === person.id)) warnings.push(`Человек древа ${person.id} ещё не связан с evidence-кандидатом.`);
    }
    for (const relation of tree.relations) {
      if (!researchCase.relationships.some(item => item.treeRelationId === relation.id && item.status !== 'contradicted')) warnings.push(`Связь древа ${relation.id} ещё не отражена как активная evidence-связь.`);
    }
  }
  for (const claim of researchCase.claims) {
    if (!VALID_STATUSES.has(claim.status)) errors.push(`${claim.id}: неизвестный статус ${claim.status}.`);
    for (const personId of claim.subjectPersonIds) if (!personIds.has(personId)) errors.push(`${claim.id}: неизвестный person id ${personId}.`);
    for (const artifactId of [...claim.artifactIds, ...claim.contradictingArtifactIds]) {
      if (!artifactIds.has(artifactId)) errors.push(`${claim.id}: неизвестный artifact id ${artifactId}.`);
      const artifact = researchCase.artifacts.find(item => item.id === artifactId);
      if (claim.artifactIds.includes(artifactId) && artifact && !artifact.relatedClaimIds.includes(claim.id)) warnings.push(`${claim.id}: артефакт ${artifactId} не содержит обратную ссылку на claim.`);
    }
    for (const contradictsId of claim.contradictsClaimIds) if (!claimIds.has(contradictsId)) errors.push(`${claim.id}: неизвестный противоречащий claim id ${contradictsId}.`);
    const groups = new Set([
      ...claim.supportingIndependenceGroups,
      ...claim.artifactIds.map(id => researchCase.artifacts.find(item => item.id === id)?.independenceGroup).filter((item): item is string => Boolean(item)),
    ]);
    if (CORROBORATED.has(claim.status) && groups.size < 2) warnings.push(`${claim.id}: статус ${claim.status}, но независимых групп меньше двух.`);
    if (CORROBORATED.has(claim.status) && !claim.rationale.trim()) warnings.push(`${claim.id}: для ${claim.status} отсутствует обоснование.`);
    if (claim.status === 'single-source' && groups.size > 1) warnings.push(`${claim.id}: несколько независимых групп при статусе single-source; проверьте конфликт или полноту анализа.`);
    if (claim.status === 'strongly-corroborated') {
      const artifacts = claim.artifactIds.map(id => researchCase.artifacts.find(item => item.id === id)).filter((item): item is ResearchArtifact => Boolean(item));
      if (!artifacts.some(item => item.directness === 'direct')) warnings.push(`${claim.id}: strongly-corroborated без прямого артефакта.`);
      if (!artifacts.some(item => ['original', 'image-of-original', 'official-extract'].includes(item.originality))) warnings.push(`${claim.id}: strongly-corroborated без оригинала, образа оригинала или официальной выписки.`);
    }
  }
  for (const relationship of researchCase.relationships) {
    if (!personIds.has(relationship.personAId) || !personIds.has(relationship.personBId)) errors.push(`${relationship.id}: связь ссылается на неизвестного человека.`);
    for (const claimId of relationship.claimIds) if (!claimIds.has(claimId)) errors.push(`${relationship.id}: неизвестный claim id ${claimId}.`);
    for (const artifactId of [...relationship.supportingArtifactIds, ...relationship.contradictingArtifactIds]) if (!artifactIds.has(artifactId)) errors.push(`${relationship.id}: неизвестный artifact id ${artifactId}.`);
    if (CORROBORATED.has(relationship.status) && new Set(relationship.independenceGroups).size < 2) warnings.push(`${relationship.id}: статус ${relationship.status}, но независимых групп меньше двух.`);
  }
  for (const search of researchCase.searches) {
    for (const personId of search.targetPersonIds) if (!personIds.has(personId)) errors.push(`${search.id}: неизвестный target person id ${personId}.`);
    for (const artifactId of search.artifactIds) if (!artifactIds.has(artifactId)) errors.push(`${search.id}: неизвестный artifact id ${artifactId}.`);
    if (search.resultStatus === 'not-found-in-scope' && !search.coverageNotes) warnings.push(`${search.id}: отрицательный результат без описания просмотренного объёма.`);
    if (search.captchaAttempts !== 0) errors.push(`${search.id}: агент не должен предпринимать попытки прохождения CAPTCHA.`);
  }
  return {
    counts: {
      people: researchCase.people.length,
      artifacts: researchCase.artifacts.length,
      claims: researchCase.claims.length,
      relationships: researchCase.relationships.length,
      searches: researchCase.searches.length,
    },
    errors,
    warnings,
  };
}

export function researchContext(): string {
  const researchCase = read();
  const audit = auditEvidence(researchCase);
  const people = researchCase.people.slice(-20).map(person => `- [${person.id}] ${person.preferredLabel}; ${person.candidateStatus}${person.treePersonId ? `; tree=${person.treePersonId}` : '; не связан с древом'}`);
  const claims = researchCase.claims.slice(-30).map(claim => `- [${claim.id}] ${claim.status}: ${claim.claimText} (артефакты: ${claim.artifactIds.join(', ') || 'нет'})`);
  const relationships = researchCase.relationships.slice(-15).map(relation => `- [${relation.id}] ${relation.personAId} — ${relation.relationshipType}/${relation.basis} — ${relation.personBId}; ${relation.status}`);
  return [
    `Дело ${researchCase.id}: кандидатов ${researchCase.people.length}, артефактов ${researchCase.artifacts.length}, утверждений ${researchCase.claims.length}, связей ${researchCase.relationships.length}, поисков ${researchCase.searches.length}.`,
    audit.errors.length || audit.warnings.length ? `Аудит: ошибок ${audit.errors.length}, предупреждений ${audit.warnings.length}.` : 'Аудит: структурных проблем нет.',
    `Кандидаты:\n${people.join('\n') || '- пока нет'}`,
    `Последние утверждения:\n${claims.join('\n') || '- пока нет'}`,
    `Исследуемые связи:\n${relationships.join('\n') || '- пока нет'}`,
  ].join('\n\n');
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).toUpperCase();
}

function manualIndependenceGroup(input: ManualArtifactInput): string {
  const lineage = input.archivalReference
    ? [input.repositoryOrArchive ?? 'unknown-repository', input.archivalReference]
    : input.externalRecordId
      ? [input.repositoryOrArchive ?? input.sourceType, input.externalRecordId]
      : input.sha256
        ? ['sha256', input.sha256.toLowerCase()]
        : null;
  return lineage ? `SOURCE-${stableHash(lineage.join('|'))}` : 'MANUAL-LINEAGE-UNVERIFIED';
}

function explicitIdentityConfirmation(text: string): boolean {
  return /(?:подтвержда(?:ю|ем)|объедин(?:и|ить|яй)|один и тот же человек|тот же человек|это он|это она)/iu.test(text);
}

function evidenceStatusRank(status: EvidenceStatus): number {
  if (status === 'strongly-corroborated') return 4;
  if (status === 'corroborated') return 3;
  if (status === 'single-source') return 2;
  if (status === 'hypothesis') return 1;
  return 0;
}

function mergeResearchPeople(draft: ResearchCase, source: ResearchPerson, target: ResearchPerson, rationale: string): void {
  for (const name of source.names) if (!target.names.some(item => item.asWritten === name.asWritten)) target.names.push(name);
  target.placesAsWritten = [...new Set([...target.placesAsWritten, ...source.placesAsWritten])];
  target.historicalJurisdictions = [...new Set([...target.historicalJurisdictions, ...source.historicalJurisdictions])];
  target.sourceArtifactIds = [...new Set([...target.sourceArtifactIds, ...source.sourceArtifactIds])];
  target.birthEstimate ??= source.birthEstimate;
  target.deathEstimate ??= source.deathEstimate;
  if (target.livingStatus === 'unknown') target.livingStatus = source.livingStatus;
  target.candidateStatus = 'identified';
  target.mergeOrSplitRationale = appendNote(target.mergeOrSplitRationale, rationale);
  target.notes = appendNote(target.notes, source.notes);
  target.updatedAt = now();
  for (const artifact of draft.artifacts) artifact.personIds = replaceId(artifact.personIds, source.id, target.id);
  for (const claim of draft.claims) claim.subjectPersonIds = replaceId(claim.subjectPersonIds, source.id, target.id);
  for (const relationship of draft.relationships) {
    if (relationship.personAId === source.id) relationship.personAId = target.id;
    if (relationship.personBId === source.id) relationship.personBId = target.id;
  }
  for (const search of draft.searches) search.targetPersonIds = replaceId(search.targetPersonIds, source.id, target.id);
  draft.people = draft.people.filter(item => item.id !== source.id);
}

function replaceId(values: string[], from: string, to: string): string[] {
  return [...new Set(values.map(value => value === from ? to : value))];
}

function appendNote(existing: string | undefined, addition: string | undefined): string | undefined {
  if (!addition) return existing;
  if (!existing) return addition;
  return existing.includes(addition) ? existing : `${existing} ${addition}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'field';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function validateClaimReferences(researchCase: ResearchCase, claim: Omit<ResearchClaim, 'id' | 'createdAt' | 'updatedAt'>): void {
  const people = new Set(researchCase.people.map(item => item.id));
  const artifacts = new Set(researchCase.artifacts.map(item => item.id));
  const claims = new Set(researchCase.claims.map(item => item.id));
  for (const personId of claim.subjectPersonIds) if (!people.has(personId)) throw new Error(`Неизвестный person id ${personId}.`);
  for (const artifactId of [...claim.artifactIds, ...claim.contradictingArtifactIds]) if (!artifacts.has(artifactId)) throw new Error(`Неизвестный artifact id ${artifactId}.`);
  for (const claimId of claim.contradictsClaimIds) if (!claims.has(claimId)) throw new Error(`Неизвестный contradicting claim id ${claimId}.`);
  if (CORROBORATED.has(claim.status) && new Set(claim.supportingIndependenceGroups).size < 2) throw new Error(`${claim.status} требует минимум две независимые группы.`);
  if (CORROBORATED.has(claim.status) && !claim.rationale.trim()) throw new Error(`${claim.status} требует объяснить независимость и идентификацию.`);
}

function validateRelationshipReferences(researchCase: ResearchCase, relationship: Omit<ResearchRelationship, 'id' | 'createdAt' | 'updatedAt'>): void {
  const people = new Set(researchCase.people.map(item => item.id));
  const artifacts = new Set(researchCase.artifacts.map(item => item.id));
  const claims = new Set(researchCase.claims.map(item => item.id));
  for (const personId of [relationship.personAId, relationship.personBId]) if (!people.has(personId)) throw new Error(`Неизвестный person id ${personId}.`);
  for (const claimId of relationship.claimIds) if (!claims.has(claimId)) throw new Error(`Неизвестный claim id ${claimId}.`);
  for (const artifactId of [...relationship.supportingArtifactIds, ...relationship.contradictingArtifactIds]) if (!artifacts.has(artifactId)) throw new Error(`Неизвестный artifact id ${artifactId}.`);
  if (CORROBORATED.has(relationship.status) && new Set(relationship.independenceGroups).size < 2) throw new Error(`${relationship.status} требует минимум две независимые группы.`);
  if (CORROBORATED.has(relationship.status) && !relationship.rationale.trim()) throw new Error(`${relationship.status} требует объяснение.`);
}
