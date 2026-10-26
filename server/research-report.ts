import type { ResearchCase, ResearchPerson } from '../shared/types.js';
import { auditEvidence, getResearchCase } from './research-store.js';
import { getTree } from './tree-store.js';

export function renderResearchReport(options: { redactLivingPeople?: boolean } = {}, researchCase: ResearchCase = getResearchCase()): string {
  const redact = options.redactLivingPeople ?? researchCase.privacy.redactLivingPeopleInSharedReport;
  const audit = auditEvidence(researchCase, getTree());
  const privatePersonIds = new Set(researchCase.people.filter(person => person.livingStatus !== 'deceased').map(person => person.id));
  const hasLivingPeople = redact && privatePersonIds.size > 0;
  const containsLiving = (personIds: string[]) => redact && personIds.some(personId => privatePersonIds.has(personId));
  const label = (personId: string) => personLabel(researchCase.people.find(person => person.id === personId), redact);
  const lines = [
    '# Исследование родственных связей',
    '',
    '## 1. Исследовательский вопрос',
    '',
    hasLivingPeople ? '_Скрыто: дело содержит сведения о живых лицах._' : researchCase.researchQuestion || '_Главный вопрос ещё не зафиксирован._',
    '',
    `- Период: ${hasLivingPeople ? '[скрыто]' : researchCase.scope.timeRange || 'не указан'}`,
    `- География: ${hasLivingPeople ? '[скрыто]' : researchCase.scope.geographicScope.join(', ') || 'не указана'}`,
    `- Запрещённые источники: ${hasLivingPeople ? '[скрыто]' : researchCase.scope.prohibitedSources.join(', ') || 'нет'}`,
    '',
    '## 2. Краткое состояние',
    '',
    `Кандидаты: ${researchCase.people.length}; артефакты: ${researchCase.artifacts.length}; утверждения: ${researchCase.claims.length}; исследуемые связи: ${researchCase.relationships.length}; поиски: ${researchCase.searches.length}.`,
    `Структурный аудит: ошибок ${audit.errors.length}, предупреждений ${audit.warnings.length}. Аудит проверяет целостность, но не объявляет выводы истинными.`,
    '',
    '## 3. Идентифицированные лица и кандидаты',
    '',
    '| Person ID | Метка | Статус | Даты | Места | Связь с древом |',
    '| --- | --- | --- | --- | --- | --- |',
    ...researchCase.people.map(person => {
      const hidden = redact && person.livingStatus !== 'deceased';
      return `| ${person.id} | ${escapeCell(personLabel(person, redact))} | ${person.candidateStatus} | ${hidden ? '[скрыто]' : escapeCell([person.birthEstimate, person.deathEstimate].filter(Boolean).join(' — ') || '—')} | ${hidden ? '[скрыто]' : escapeCell(person.placesAsWritten.join('; ') || '—')} | ${person.treePersonId ?? 'не связан'} |`;
    }),
    '',
    '## 4. Проверка родственных связей',
    '',
    ...(researchCase.relationships.length ? researchCase.relationships.flatMap(relationship => [
      `### ${relationship.id}: ${label(relationship.personAId)} — ${relationship.relationshipType}/${relationship.basis} — ${label(relationship.personBId)}`,
      '',
      `- Статус: **${relationship.status}**; уверенность: ${relationship.confidence}.`,
      `- Утверждения: ${relationship.claimIds.join(', ') || 'нет'}.`,
      `- Поддерживающие артефакты: ${relationship.supportingArtifactIds.join(', ') || 'нет'}.`,
      `- Независимые группы: ${relationship.independenceGroups.join(', ') || 'нет'}.`,
      `- Противоречия: ${relationship.contradictingArtifactIds.join(', ') || 'нет'}.`,
      `- Обоснование: ${containsLiving([relationship.personAId, relationship.personBId]) ? '[скрыто: данные живого лица]' : relationship.rationale}`,
      '',
    ]) : ['_Связи ещё не оформлены как доказательные цепочки._', '']),
    '## 5. Матрица утверждений',
    '',
    '| Claim ID | Утверждение | Статус | Поддержка | Противоречия | Обоснование |',
    '| --- | --- | --- | --- | --- | --- |',
    ...researchCase.claims.map(claim => `| ${claim.id} | ${containsLiving(claim.subjectPersonIds) ? '[скрыто: данные живого лица]' : escapeCell(claim.claimText)} | ${claim.status} | ${escapeCell(claim.artifactIds.join(', ') || 'нет')} | ${escapeCell([...claim.contradictingArtifactIds, ...claim.contradictsClaimIds].join(', ') || 'нет')} | ${containsLiving(claim.subjectPersonIds) ? '[скрыто]' : escapeCell(claim.rationale)} |`),
    '',
    '## 6. Существенные противоречия',
    '',
    ...contradictionLines(researchCase, redact, privatePersonIds),
    '',
    '## 7. Неудачные и неполные поиски',
    '',
    '| Search ID | Источник и запрос | Результат | Покрытие/блокировка | Следующий шаг |',
    '| --- | --- | --- | --- | --- |',
    ...researchCase.searches.filter(search => search.resultStatus !== 'found').map(search => {
      const hidden = containsLiving(search.targetPersonIds);
      return `| ${search.id} | ${hidden ? '[скрыто: поиск живого лица]' : escapeCell(`${search.sourceOrDomain}: ${search.query}`)} | ${search.resultStatus} | ${hidden ? '[скрыто]' : escapeCell([search.coverageNotes, search.blocker].filter(Boolean).join(' ') || 'не описано')} | ${hidden ? '[скрыто]' : escapeCell(search.nextStep || 'не указан')} |`;
    }),
    '',
    '## 8. Реестр артефактов',
    '',
    '| Artifact ID | Источник | Тип | Архивная ссылка/URL | Independence group | Оценка |',
    '| --- | --- | --- | --- | --- | --- |',
    ...researchCase.artifacts.map(artifact => {
      const hidden = containsLiving(artifact.personIds);
      return `| ${artifact.id} | ${hidden ? '[скрыто: артефакт живого лица]' : escapeCell(artifact.sourceTitle)} | ${artifact.originality}/${artifact.directness} | ${hidden ? '[скрыто]' : escapeCell([artifact.archivalReference, artifact.sourceUrlOrPath].filter(Boolean).join(' · ') || '—')} | ${hidden ? '[скрыто]' : escapeCell(artifact.independenceGroup)} | ${artifact.provenanceLevel}; ${artifact.legibility} |`;
    }),
    '',
    '## 9. Аудит и ограничения',
    '',
    ...(audit.errors.length ? ['Ошибки:', ...audit.errors.map(error => `- ${error}`)] : ['Ошибок ссылочной целостности не найдено.']),
    ...(audit.warnings.length ? ['', 'Предупреждения:', ...audit.warnings.map(warning => `- ${warning}`)] : []),
    '',
    redact ? '_Данные лиц со статусом living скрыты в этой версии отчёта._' : '_Это полная локальная версия. Перед передачей третьим лицам включите редактирование живых людей._',
    '',
  ];
  return lines.join('\n');
}

function personLabel(person: ResearchPerson | undefined, redact: boolean): string {
  if (!person) return 'неизвестный person id';
  return redact && person.livingStatus !== 'deceased' ? person.id : person.preferredLabel;
}

function contradictionLines(researchCase: ResearchCase, redact: boolean, livingIds: Set<string>): string[] {
  const claims = researchCase.claims.filter(claim => claim.status === 'contradicted' || claim.contradictingArtifactIds.length || claim.contradictsClaimIds.length);
  if (!claims.length) return ['_Зафиксированных противоречий пока нет._'];
  return claims.map(claim => redact && claim.subjectPersonIds.some(personId => livingIds.has(personId))
    ? `- **${claim.id}**: [скрыто: данные живого лица].`
    : `- **${claim.id}**: ${claim.claimText}. Противоречия: ${[...claim.contradictingArtifactIds, ...claim.contradictsClaimIds].join(', ') || 'статус contradicted'}.`);
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
