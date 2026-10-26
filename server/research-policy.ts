export type ResearchPolicyCode =
  | 'namesakes-separate'
  | 'dependent-copies'
  | 'preserve-conflict'
  | 'captcha-human-only'
  | 'unindexed-scan'
  | 'birthplace-distinction'
  | 'sources-exhausted'
  | 'repression-caution'
  | 'living-person-privacy'
  | 'direct-record-single-source'
  | 'grandparent-two-edges';

export type ResearchPolicyDirective = { code: ResearchPolicyCode; instruction: string };

const RULES: { code: ResearchPolicyCode; pattern: RegExp; instruction: string }[] = [
  {
    code: 'namesakes-separate',
    pattern: /два|три|несколько|однофам|т[её]зк|одинаков(ое|ые) (имя|фамил)|same name|namesake/i,
    instruction: 'Создай отдельный person id для каждого кандидата. Не выбирай по одному имени или возрасту; ищи дом, родителей, супругов, свидетелей, профессию и точную дату.',
  },
  {
    code: 'dependent-copies',
    pattern: /тр[её]х? (сайт|генеалог)|нескольк.*сайт|копи|зеркал|один индекс|same.*index|copied/i,
    instruction: 'Проверь общее происхождение. Копиям, зеркалам и индексам одной записи назначь одну independence group и не повышай статус по числу URL.',
  },
  {
    code: 'preserve-conflict',
    pattern: /а (в|семья)|но (в|семья)|расход|противореч|конфликт|\b(18|19|20)\d{2}\b.*\b(18|19|20)\d{2}\b|different.*date|conflict/i,
    instruction: 'Сохрани версии отдельными claims с их источниками. Не усредняй и не перезаписывай; оцени информанта и найди различающий источник.',
  },
  {
    code: 'captcha-human-only',
    pattern: /captcha|капч|провер(к|ку) безопасности|solver|обойти.*защит/i,
    instruction: 'Не проходи и не обходи CAPTCHA. Запиши блокировку, URL и запрос, передай точный ручной шаг человеку и ищи альтернативный официальный путь.',
  },
  {
    code: 'unindexed-scan',
    pattern: /familysearch.*(фильм|скан|книг)|неиндекс|поиск по имени ничего|images only|unindexed/i,
    instruction: 'Пустой индекс не является отрицательным результатом. Построй карту кадров фильма, просмотри ключевой столбец и зафиксируй отсутствующие онлайн годы и типы записей.',
  },
  {
    code: 'birthplace-distinction',
    pattern: /паспорт.*сел|место рождения.*семь|родил.*вырос|birthplace.*family/i,
    instruction: 'Сохрани документальную и семейную версии отдельно. Проверь исчезнувший хутор и смену района; различай «родился» и «вырос».',
  },
  {
    code: 'sources-exhausted',
    pattern: /открыт.*(источник|баз).*ничего|источник.*исчерпан|вс[её] просмотр|sources exhausted|nothing.*database/i,
    instruction: 'Один раз перечисли установленное, неизвестное и покрытие. Подготовь вопросы родственникам и проекты запросов в архив/ЗАГС, затем не повторяй поиск по кругу.',
  },
  {
    code: 'repression-caution',
    pattern: /репресс|депорт|выслан|25 лет|оун|мгб|гулаг|repression|deport/i,
    instruction: 'Отделяй текст списка от обвинения. Срок или основание выселения не доказывает конкретное деяние; для вывода запроси дело и формулируй чувствительные сведения нейтрально.',
  },
  {
    code: 'living-person-privacy',
    pattern: /жив(ой|ая|ые|ых)|телефон|адрес|текущ.*контакт|соцсет|living.*(phone|address|contact)/i,
    instruction: 'Не ищи текущие контакты, адреса и аккаунты живых людей. Сузь задачу до исторической цепочки и минимизируй данные живых лиц.',
  },
  {
    code: 'direct-record-single-source',
    pattern: /(акт|запис).*(прямо|назван).*(родител|отец|мать)|both parents.*record|direct.*record/i,
    instruction: 'Оцени прямую запись как сильную, но оставь claim в single-source до независимого кроссподтверждения.',
  },
  {
    code: 'grandparent-two-edges',
    pattern: /дед|бабуш|внук|внучк|grand(parent|mother|father|child)/i,
    instruction: 'Связь дед/бабушка–внук/внучка разложи на два отдельных ребра родитель–ребёнок и проверь каждое отдельно. Если промежуточный родитель не назван, не выдумывай его личность: допустим только явно неизвестный placeholder с provenance hypothesis, и оба ребра через него тоже hypothesis.',
  },
];

export function researchPolicyDirectives(text: string): ResearchPolicyDirective[] {
  return RULES.filter(rule => rule.pattern.test(text)).map(({ code, instruction }) => ({ code, instruction }));
}

export function researchPolicyFor(text: string): string {
  const directives = researchPolicyDirectives(text);
  if (directives.length === 0) return '';
  return `Детерминированные правила для текущего запроса:\n${directives.map(item => `- [${item.code}] ${item.instruction}`).join('\n')}`;
}
