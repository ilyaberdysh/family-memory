import { tool } from 'ai';
import { z } from 'zod';
import { recordObdRecord, recordObdSearch, registerSearchAttempt } from './research-store.js';
import { CheckRequired } from './sources/browser.js';
import { searchLinks } from './sources/links.js';
import { readObdRecord, searchObd } from './sources/obd-memorial.js';

const personQuery = {
  lastName: z.string().min(2).max(60).describe('Фамилия в именительном падеже. Для женщин — фамилия на момент войны (часто девичья).'),
  firstName: z.string().max(40).optional(),
  patronymic: z.string().max(40).optional(),
  birthYear: z.number().int().min(1850).max(1930).optional().describe('Если известен хотя бы примерно; людей, родившихся позже 1930 года, автоматически не ищем'),
};

export function assertSearchSubjectEligible(query: { birthYear?: number }): void {
  if (query.birthYear !== undefined && query.birthYear > 1930) {
    throw new Error('Автоматический поиск людей, родившихся позже 1930 года, отключён для защиты живых лиц.');
  }
}

export const researchTools = {
  search_obd_memorial: tool({
    description: 'Поиск в ОБД «Мемориал» (Минобороны): погибшие и пропавшие без вести в 1941–1945, донесения о потерях, книги памяти. Подходит для людей примерно 1880–1927 г. р. Возвращает кандидатов — это ещё не подтверждение родства.',
    inputSchema: z.object(personQuery),
    execute: async query => {
      assertSearchSubjectEligible(query);
      try {
        const result = await searchObd(query);
        recordObdSearch(result, queryFilters(query));
        return result;
      } catch (error) {
        if (error instanceof CheckRequired) {
          registerSearchAttempt({
            targetPersonIds: [],
            researchGoal: 'Поиск кандидатов в ОБД «Мемориал».',
            query: describeQuery(query),
            languageLocale: 'ru-RU',
            sourceOrDomain: 'obd-memorial.ru',
            filters: queryFilters(query),
            resultStatus: 'blocked',
            artifactIds: [],
            blocker: error.message,
            coverageNotes: 'Источник остановил автоматический доступ. Поиск не завершён и не является отрицательным результатом.',
            nextStep: 'Пользователь может открыть подготовленную ссылку вручную; агент тем временем ищет допустимый альтернативный маршрут.',
          });
          return { blocked: true, message: error.message, links: searchLinks(query) };
        }
        registerSearchAttempt({
          targetPersonIds: [],
          researchGoal: 'Поиск кандидатов в ОБД «Мемориал».',
          query: describeQuery(query),
          languageLocale: 'ru-RU',
          sourceOrDomain: 'obd-memorial.ru',
          filters: queryFilters(query),
          resultStatus: 'error',
          artifactIds: [],
          blocker: (error as Error).message.slice(0, 500),
          coverageNotes: 'Техническая ошибка не означает отсутствие записи.',
          nextStep: 'Повторить позже или открыть официальный поиск вручную.',
        });
        throw new Error(`ОБД «Мемориал» не ответил: ${(error as Error).message.slice(0, 160)}`);
      }
    },
  }),

  read_obd_record: tool({
    description: 'Открыть карточку записи ОБД «Мемориал» и прочитать подробности: место рождения, часть, звание, причина и дата выбытия, место захоронения, архивный шифр ЦАМО. Используй для 1–3 самых похожих кандидатов, чтобы сравнить с рассказом.',
    inputSchema: z.object({ id: z.string().describe('id из ссылки info.htm?id=…') }),
    execute: async ({ id }) => {
      try {
        const record = await readObdRecord(id);
        const evidence = recordObdRecord(record);
        return { ...record, evidence: { artifactId: evidence.artifact.id, candidatePersonId: evidence.person.id, claimIds: evidence.claims.map(claim => claim.id) } };
      } catch (error) {
        if (error instanceof CheckRequired) {
          registerSearchAttempt({
            targetPersonIds: [],
            researchGoal: `Открыть карточку ОБД ${id}.`,
            query: `record id=${id}`,
            languageLocale: 'ru-RU',
            sourceOrDomain: 'obd-memorial.ru',
            filters: { id },
            resultStatus: 'blocked',
            artifactIds: [],
            blocker: error.message,
            coverageNotes: 'Карточка не просмотрена из-за проверки безопасности.',
            nextStep: `Открыть https://obd-memorial.ru/html/info.htm?id=${id} вручную и вернуть ссылку или снимок записи.`,
          });
          return { blocked: true, message: error.message };
        }
        registerSearchAttempt({
          targetPersonIds: [],
          researchGoal: `Открыть карточку ОБД ${id}.`,
          query: `record id=${id}`,
          languageLocale: 'ru-RU',
          sourceOrDomain: 'obd-memorial.ru',
          filters: { id },
          resultStatus: 'error',
          artifactIds: [],
          blocker: (error as Error).message.slice(0, 500),
          coverageNotes: 'Техническая ошибка чтения карточки не означает отсутствие записи.',
          nextStep: 'Повторить позже или открыть официальную карточку вручную.',
        });
        throw new Error(`Не удалось открыть запись: ${(error as Error).message.slice(0, 160)}`);
      }
    },
  }),

  prepare_search_links: tool({
    description: 'Подготовить точные ссылки поиска по источникам, которые человек откроет сам: «Память народа» (сайт с проверкой безопасности), FamilySearch (нужен аккаунт), ОБД «Мемориал».',
    inputSchema: z.object(personQuery),
    execute: async query => {
      assertSearchSubjectEligible(query);
      return { links: searchLinks(query) };
    },
  }),
};

function queryFilters(query: { lastName: string; firstName?: string; patronymic?: string; birthYear?: number }): Record<string, string> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
}

function describeQuery(query: { lastName: string; firstName?: string; patronymic?: string; birthYear?: number }): string {
  return [query.lastName, query.firstName, query.patronymic, query.birthYear && `${query.birthYear} г. р.`].filter(Boolean).join(' ');
}
