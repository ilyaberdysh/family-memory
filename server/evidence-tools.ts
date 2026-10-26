import { tool } from 'ai';
import { z } from 'zod';
import {
  auditEvidence,
  createManualArtifact,
  createManualCandidate,
  createManualClaim,
  createManualRelationship,
  getResearchCase,
  linkCandidateToTreePerson,
  registerSearchAttempt,
  updatePersonCandidate,
  updateResearchScope,
} from './research-store.js';
import { getTree } from './tree-store.js';
import { renderResearchReport } from './research-report.js';

const evidenceStatus = z.enum(['hypothesis', 'single-source', 'corroborated', 'strongly-corroborated', 'contradicted', 'unresolved']);
const confidence = z.enum(['low', 'moderate', 'high']);

export const evidenceTools = {
  set_research_scope: tool({
    description: 'Зафиксировать главный исследовательский вопрос, период, географию и ограничения дела. Обновляй только сведения, которые пользователь действительно сообщил; разрешения по умолчанию остаются выключенными.',
    inputSchema: z.object({
      researchQuestion: z.string().max(1_000).optional(),
      requestedOutputLanguage: z.string().max(50).optional(),
      targetRelationship: z.string().max(500).optional(),
      timeRange: z.string().max(300).optional(),
      geographicScope: z.array(z.string().max(300)).max(50).optional(),
      allowedSources: z.array(z.string().max(300)).max(100).optional(),
      prohibitedSources: z.array(z.string().max(300)).max(100).optional(),
      paidSourcesAllowed: z.boolean().optional(),
      thirdPartyUploadAllowed: z.boolean().optional(),
      contactWithPeopleOrArchivesAllowed: z.boolean().optional(),
      sensitiveTopics: z.array(z.string().max(300)).max(50).optional(),
    }),
    execute: async input => updateResearchScope(input),
  }),

  inspect_research_case: tool({
    description: 'Прочитать структурированное исследовательское дело: кандидатов, артефакты, утверждения, связи, последние поиски и результат аудита. Используй перед сопоставлением кандидатов и не полагайся только на визуальное древо.',
    inputSchema: z.object({
      personId: z.string().optional().describe('Если указан, вернуть материалы только об этом исследовательском person id.'),
    }),
    execute: async ({ personId }) => {
      const researchCase = getResearchCase();
      const people = personId ? researchCase.people.filter(item => item.id === personId) : researchCase.people.slice(-30);
      const personIds = new Set(people.map(item => item.id));
      return {
        case: { id: researchCase.id, researchQuestion: researchCase.researchQuestion, requestedOutputLanguage: researchCase.requestedOutputLanguage },
        people,
        artifacts: (personId ? researchCase.artifacts.filter(item => item.personIds.includes(personId)) : researchCase.artifacts.slice(-30)),
        claims: (personId ? researchCase.claims.filter(item => item.subjectPersonIds.some(id => personIds.has(id))) : researchCase.claims.slice(-50)),
        relationships: (personId ? researchCase.relationships.filter(item => personIds.has(item.personAId) || personIds.has(item.personBId)) : researchCase.relationships.slice(-30)),
        searches: researchCase.searches.slice(-20),
        audit: auditEvidence(researchCase, getTree()),
      };
    },
  }),

  create_person_candidate: tool({
    description: 'Создать отдельного кандидата на личность, не добавляя и не объединяя его с человеком в древе. Используй для одноимённых людей и альтернативных идентификаций.',
    inputSchema: z.object({
      label: z.string().min(1).max(160),
      namesAsWritten: z.array(z.string().min(1).max(160)).min(1).max(20),
      livingStatus: z.enum(['living', 'deceased', 'unknown']).optional(),
      rationale: z.string().max(1_000).optional().describe('Почему кандидат должен оставаться отдельным или какие признаки его различают.'),
    }),
    execute: async input => createManualCandidate(input),
  }),

  update_person_candidate: tool({
    description: 'Уточнить отдельного кандидата: исходные варианты имени, диапазоны дат, места и исторические юрисдикции. Не используй это как скрытое слияние двух людей.',
    inputSchema: z.object({
      id: z.string(),
      preferredLabel: z.string().max(160).optional(),
      livingStatus: z.enum(['living', 'deceased', 'unknown']).optional(),
      namesAsWritten: z.array(z.string().max(160)).max(30).optional(),
      birthEstimate: z.string().max(300).optional(),
      deathEstimate: z.string().max(300).optional(),
      placesAsWritten: z.array(z.string().max(500)).max(50).optional(),
      historicalJurisdictions: z.array(z.string().max(500)).max(50).optional(),
      candidateStatus: z.enum(['candidate', 'identified', 'separate', 'rejected']).optional(),
      mergeOrSplitRationale: z.string().max(2_000).optional(),
      notes: z.string().max(2_000).optional(),
    }),
    execute: async input => updatePersonCandidate(input),
  }),

  record_artifact: tool({
    description: 'Сохранить предоставленный пользователем документ, веб-страницу или архивную запись как артефакт до интерпретации. Для автоматических источников используй их специализированные инструменты: они фиксируют метаданные сами.',
    inputSchema: z.object({
      stableKey: z.string().max(500).optional(),
      sourceTitle: z.string().min(1).max(500),
      sourceUrlOrPath: z.string().max(2_000).optional(),
      sourceType: z.string().min(1).max(120),
      repositoryOrArchive: z.string().max(500).optional(),
      archivalReference: z.string().max(1_000).optional(),
      externalRecordId: z.string().max(300).optional(),
      recordDateAsWritten: z.string().max(300).optional(),
      placeAsWritten: z.string().max(500).optional(),
      languageScript: z.string().max(100).optional(),
      personIds: z.array(z.string()).max(30).default([]),
      namesAsWritten: z.array(z.string()).max(50).default([]),
      summary: z.string().min(1).max(4_000),
      rawFields: z.array(z.object({ label: z.string().max(500), value: z.string().max(4_000) })).max(100).optional(),
      provenanceLevel: z.enum(['known', 'partial', 'unknown']),
      directness: z.enum(['direct', 'indirect', 'negative', 'lead-only']),
      originality: z.enum(['original', 'image-of-original', 'official-extract', 'index', 'transcription', 'derivative', 'user-statement', 'unknown']),
      independenceGroup: z.string().min(1).max(500).optional().describe('Подсказка не считается доверенной: сервер выводит группу из архивного шифра, внешнего id или SHA-256.'),
      legibility: z.enum(['clear', 'partial', 'poor', 'unreadable', 'not-applicable']),
      accessNotes: z.string().max(2_000).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      reliabilityNotes: z.string().max(2_000).optional(),
    }),
    execute: async input => createManualArtifact({ ...input, rawFields: input.rawFields ? Object.fromEntries(input.rawFields.map(item => [item.label, item.value])) : undefined }),
  }),

  record_evidence_claim: tool({
    description: 'Записать одно атомарное проверяемое утверждение с поддерживающими и противоречащими артефактами. Не объединяй несколько фактов в одно утверждение и не ставь corroborated без двух независимых групп.',
    inputSchema: z.object({
      claimText: z.string().min(1).max(2_000),
      subjectPersonIds: z.array(z.string()).min(1).max(10),
      claimType: z.string().min(1).max(120),
      valueAsWritten: z.string().max(1_000).optional(),
      normalizedValue: z.string().max(1_000).optional(),
      calendar: z.enum(['Julian', 'Gregorian', 'unknown', 'other']).optional(),
      artifactIds: z.array(z.string()).max(30).default([]),
      contradictingArtifactIds: z.array(z.string()).max(30).default([]),
      contradictsClaimIds: z.array(z.string()).max(30).default([]),
      status: evidenceStatus,
      confidence,
      rationale: z.string().min(1).max(3_000),
      nextAction: z.string().max(2_000).optional(),
    }),
    execute: async input => createManualClaim({ ...input, supportingIndependenceGroups: [] }),
  }),

  record_relationship_evidence: tool({
    description: 'Записать исследуемую связь между двумя отдельными person id. Дед/внук не записывай одним прыжком: создай два ребра родитель–ребёнок.',
    inputSchema: z.object({
      personAId: z.string(),
      relationshipType: z.enum(['parent', 'spouse', 'sibling', 'guardian', 'household', 'other']),
      personBId: z.string(),
      basis: z.enum(['biological', 'legal', 'adoptive', 'step', 'guardian', 'household', 'unknown']),
      claimIds: z.array(z.string()).max(30).default([]),
      supportingArtifactIds: z.array(z.string()).max(30).default([]),
      contradictingArtifactIds: z.array(z.string()).max(30).default([]),
      status: evidenceStatus,
      confidence,
      rationale: z.string().min(1).max(3_000),
    }),
    execute: async input => createManualRelationship({ ...input, independenceGroups: [] }),
  }),

  link_candidate_to_tree_person: tool({
    description: 'Связать внешнего кандидата с уже существующим человеком в древе только после явного подтверждения пользователя и с объяснением различающих признаков. Инструмент не переписывает поля древа и не повышает статусы доказательств.',
    inputSchema: z.object({
      candidateId: z.string(),
      treePersonId: z.string(),
      rationale: z.string().min(10).max(3_000),
      confirmationArtifactId: z.string().describe('ID артефакта последнего сообщения пользователя с явным подтверждением идентичности.'),
    }),
    execute: async ({ candidateId, treePersonId, rationale, confirmationArtifactId }) => {
      if (!getTree().people.some(person => person.id === treePersonId)) throw new Error(`В древе нет человека ${treePersonId}.`);
      return linkCandidateToTreePerson(candidateId, treePersonId, rationale, confirmationArtifactId);
    },
  }),

  record_search_attempt: tool({
    description: 'Зафиксировать ручной, заблокированный или неполный поиск вне автоматизированных адаптеров. Автоматические инструменты ОБД пишут журнал сами; не дублируй их записи.',
    inputSchema: z.object({
      targetPersonIds: z.array(z.string()).max(20).default([]),
      researchGoal: z.string().min(1).max(1_000),
      query: z.string().min(1).max(1_000),
      languageLocale: z.string().max(50).optional(),
      sourceOrDomain: z.string().min(1).max(300),
      filters: z.array(z.object({ name: z.string().max(200), value: z.string().max(1_000) })).max(50).default([]),
      resultStatus: z.enum(['found', 'not-found-in-scope', 'blocked', 'unavailable', 'incomplete', 'error']),
      artifactIds: z.array(z.string()).max(30).default([]),
      resultCount: z.number().int().min(0).optional(),
      searchedCount: z.number().int().min(0).optional(),
      coverageNotes: z.string().max(3_000).optional(),
      blocker: z.string().max(1_000).optional(),
      nextStep: z.string().max(2_000).optional(),
    }),
    execute: async input => registerSearchAttempt({ ...input, filters: Object.fromEntries(input.filters.map(item => [item.name, item.value])) }),
  }),

  audit_evidence: tool({
    description: 'Проверить ссылочную целостность и доказательные инварианты. Аудит не устанавливает истину и не заменяет чтение источников.',
    inputSchema: z.object({}),
    execute: async () => auditEvidence(getResearchCase(), getTree()),
  }),

  draft_research_report: tool({
    description: 'Собрать воспроизводимый Markdown-отчёт из сохранённого дела: связи, утверждения, противоречия, неудачные поиски, артефакты и аудит. Не добавляет новых выводов.',
    inputSchema: z.object({
      redactLivingPeople: z.boolean().default(true).describe('Скрывать имена лиц со статусом living; по умолчанию true.'),
    }),
    execute: async ({ redactLivingPeople }) => ({ markdown: renderResearchReport({ redactLivingPeople }) }),
  }),
};
