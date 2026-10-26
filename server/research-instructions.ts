import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REFERENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/ex-ussr-kinship-research/references');
const MAX_REFERENCE_CHARS = 32_000;
const moduleCache = new Map<ModuleName, string>();

export const RESEARCH_CORE = `Ты работаешь по evidence-first методологии ex-ussr-kinship-research.

Неподлежащие нарушению правила:
- Любой новый материал сначала является артефактом, а не установленным фактом. Отделяй текст записи от интерпретации.
- Не объединяй тёзок только по ФИО, возрасту или селу. Пока личность не разрешена, сохраняй отдельных кандидатов.
- Копии, зеркала, индексы и пересказы одной записи имеют одну группу независимости и не дают кроссподтверждения.
- Одна даже сильная запись остаётся single-source. Corroborated требует двух объяснённо независимых цепочек без существенного нерешённого конфликта.
- Сохраняй исходное написание имён, дат и мест отдельно от нормализованной формы. Не исправляй источник молча.
- Сохраняй противоречия и альтернативные гипотезы. Не усредняй даты и не выбирай удобную версию.
- Отсутствие результата означает только «не найдено в просмотренном объёме». Недоступный источник, CAPTCHA и неполный индекс не являются отрицательным доказательством.
- Для исторического события определяй юрисдикцию на дату события, исходный календарь, язык и письменность.
- Не ищи текущие контакты и адреса живых людей, не публикуй лишние идентификаторы, не загружай пользовательские документы или ДНК во внешние сервисы без явного разрешения.
- Не обходи авторизацию, платный доступ, геоблокировку, rate limit, robots или CAPTCHA. CAPTCHA проходит человек; ты сохраняешь URL, запрос, блокировку и альтернативный маршрут.
- Не сообщай о поиске, просмотре или находке, если соответствующий инструмент реально не выполнил действие.
- Отвечай на языке последнего сообщения пользователя. Запросы составляй на языке источника, а цитаты сохраняй в оригинальном написании.

Древо — компактное представление, а не база доказательств. Рассказ пользователя можно сразу показать в древе как «со слов», гипотезу — пунктиром. Внешнюю запись нельзя автоматически объединять с человеком в древе.`;

type ModuleName =
  | 'evidence-protocol.md'
  | 'source-strategy.md'
  | 'ex-ussr-locale-guide.md'
  | 'field-lessons.md'
  | 'browser-and-captcha.md'
  | 'privacy-and-safety.md'
  | 'seed-sources.md';

const ROUTES: { module: ModuleName; pattern: RegExp }[] = [
  { module: 'evidence-protocol.md', pattern: /доказ|подтверж|родств|связ|однофам|т[её]зк|совпад|кандидат|документ|запис|артефакт|источник|противореч|конфликт|claim|evidence|record|source|same person/i },
  { module: 'source-strategy.md', pattern: /поиск|искать|архив|каталог|фонд|опись|дело|метр|загс|ревиз|перепис|некролог|кладбищ|search|archive|catalog/i },
  { module: 'ex-ussr-locale-guide.md', pattern: /губерн|уезд|волост|район|сельсовет|приход|топоним|село|деревн|хутор|место|границ|календар|юлиан|имя|фамил|транслитер|польск|румын|украин|идиш|немецк|jurisdiction|village|name variant/i },
  { module: 'field-lessons.md', pattern: /familysearch|фильм|кадр|скан|неиндекс|репресс|депорт|высел|раскулач|обд|мемориал|память народа|подвиг народа|военн|солдат|погиб|пропал|исчерпан|ничего не нашли|deep.zoom|military|repression|deport/i },
  { module: 'browser-and-captcha.md', pattern: /captcha|капч|авторизац|логин|войти|аккаунт|rate.?limit|429|недоступ|браузер|скач|blocked|login/i },
  { module: 'privacy-and-safety.md', pattern: /жив(ой|а[я-я]|ые)|несовершеннолет|адрес|телефон|контакт|днк|dna|усынов|отцовств|этнич|религи|медицин|паспорт|приват|соглас/i },
  { module: 'seed-sources.md', pattern: /где (ещ[её] )?искать|какие источники|список источников|новый источник|сайт|ресурс|source catalog|where.*search/i },
];

export function selectResearchModules(text: string): ModuleName[] {
  const selected = ROUTES.filter(route => route.pattern.test(text)).map(route => route.module);
  return [...new Set(selected)];
}

export function researchInstructionsFor(text: string): string {
  const modules = selectResearchModules(text);
  if (modules.length === 0) return RESEARCH_CORE;
  let remaining = MAX_REFERENCE_CHARS;
  const references: string[] = [];
  for (const module of modules) {
    if (remaining <= 0) break;
    const content = moduleCache.get(module) ?? fs.readFileSync(path.join(REFERENCE_DIR, module), 'utf8');
    moduleCache.set(module, content);
    const excerpt = content.slice(0, remaining);
    references.push(`\n\n--- Подключённый модуль: ${module} ---\n${excerpt}`);
    remaining -= excerpt.length;
  }
  return `${RESEARCH_CORE}\n\nПодключены только релевантные модули полной методологии: ${modules.join(', ')}.${references.join('')}`;
}
