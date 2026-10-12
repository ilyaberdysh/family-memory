import { tool } from 'ai';
import { z } from 'zod';
import { CheckRequired } from './sources/browser.js';
import { searchLinks } from './sources/links.js';
import { readObdRecord, searchObd } from './sources/obd-memorial.js';

const personQuery = {
  lastName: z.string().min(2).max(60).describe('Фамилия в именительном падеже. Для женщин — фамилия на момент войны (часто девичья).'),
  firstName: z.string().max(40).optional(),
  patronymic: z.string().max(40).optional(),
  birthYear: z.number().int().min(1850).max(1935).optional().describe('Если известен хотя бы примерно'),
};

export const researchTools = {
  search_obd_memorial: tool({
    description: 'Поиск в ОБД «Мемориал» (Минобороны): погибшие и пропавшие без вести в 1941–1945, донесения о потерях, книги памяти. Подходит для людей примерно 1880–1927 г. р. Возвращает кандидатов — это ещё не подтверждение родства.',
    inputSchema: z.object(personQuery),
    execute: async query => {
      try {
        return await searchObd(query);
      } catch (error) {
        if (error instanceof CheckRequired) return { blocked: true, message: error.message, links: searchLinks(query) };
        throw new Error(`ОБД «Мемориал» не ответил: ${(error as Error).message.slice(0, 160)}`);
      }
    },
  }),

  read_obd_record: tool({
    description: 'Открыть карточку записи ОБД «Мемориал» и прочитать подробности: место рождения, часть, звание, причина и дата выбытия, место захоронения, архивный шифр ЦАМО. Используй для 1–3 самых похожих кандидатов, чтобы сравнить с рассказом.',
    inputSchema: z.object({ id: z.string().describe('id из ссылки info.htm?id=…') }),
    execute: async ({ id }) => {
      try {
        return await readObdRecord(id);
      } catch (error) {
        if (error instanceof CheckRequired) return { blocked: true, message: error.message };
        throw new Error(`Не удалось открыть запись: ${(error as Error).message.slice(0, 160)}`);
      }
    },
  }),

  prepare_search_links: tool({
    description: 'Подготовить точные ссылки поиска по источникам, которые человек откроет сам: «Память народа» (сайт с проверкой безопасности), FamilySearch (нужен аккаунт), ОБД «Мемориал».',
    inputSchema: z.object(personQuery),
    execute: async query => ({ links: searchLinks(query) }),
  }),
};
