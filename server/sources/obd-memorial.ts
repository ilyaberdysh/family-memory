import type { Finding, SearchResult } from '../../shared/types.js';
import { withPage } from './browser.js';

const SOURCE = 'ОБД «Мемориал»';
const BASE = 'https://obd-memorial.ru/html/';

export type ObdQuery = { lastName: string; firstName?: string; patronymic?: string; birthYear?: number };

/** f/n/s — ФИО, y — точный год рождения, ps — записей на странице. */
export function obdSearchUrl(query: ObdQuery, options: { exactYear?: boolean; pageSize?: number } = {}): string {
  const params = new URLSearchParams({ f: query.lastName });
  if (query.firstName) params.set('n', query.firstName);
  if (query.patronymic) params.set('s', query.patronymic);
  if (options.exactYear && query.birthYear) params.set('y', String(query.birthYear));
  if (options.pageSize) params.set('ps', String(options.pageSize));
  return `${BASE}search.htm?${params}`;
}

const EXTRACT_ROWS = `[...document.querySelectorAll('.search-result')].map(node => ({
  id: node.id,
  name: node.querySelector('.search-result__col-name')?.textContent?.trim() ?? '',
  birth: node.querySelector('.search-result__col-date-birth')?.textContent?.trim() ?? '',
  out: node.querySelector('.search-result__col-date-out')?.textContent?.trim() ?? '',
  place: node.querySelector('.search-result__col-place')?.textContent?.trim() ?? '',
  kind: node.querySelector('.search-result__col-pos-and-icon img')?.getAttribute('title') ?? '',
}))`;

type Row = { id: string; name: string; birth: string; out: string; place: string; kind: string };

/** Reads the rendered results table, the same thing a person sees. */
async function readPage(url: string): Promise<{ total: number; rows: Row[] }> {
  return withPage(url, async page => {
    await page.waitForSelector('.search-result', { timeout: 20_000 }).catch(() => undefined);
    const totalText = await page.locator('text=/Записи с \\d+ по \\d+ из \\d+/').first().textContent({ timeout: 2_000 }).catch(() => null);
    // Plain string so the bundler cannot inject helpers that do not exist in the page.
    const rows = (await page.evaluate(EXTRACT_ROWS)) as Row[];
    return { total: Number(totalText?.match(/из (\d+)/)?.[1] ?? rows.length), rows };
  });
}

export async function searchObd(query: ObdQuery, limit = 15): Promise<SearchResult> {
  const searchUrl = obdSearchUrl(query);
  const broad = await readPage(obdSearchUrl(query, { pageSize: 100 }));
  let rows = broad.rows;
  // Too many namesakes to see them all: add the exact-year slice the site can filter itself.
  if (query.birthYear && broad.total > broad.rows.length) {
    const exact = await readPage(obdSearchUrl(query, { exactYear: true, pageSize: 100 }));
    const seen = new Set(rows.map(row => row.id));
    rows = [...rows, ...exact.rows.filter(row => !seen.has(row.id))];
  }

  const year = (value: string) => Number(value.match(/(1[789]\d\d|20\d\d)/)?.[1] ?? NaN);
  const scored = rows.map(row => {
    const born = year(row.birth);
    const distance = query.birthYear && !Number.isNaN(born) ? Math.abs(born - query.birthYear) : null;
    return { row, distance };
  });
  const filtered = query.birthYear
    ? scored.filter(item => item.distance === null || item.distance <= 3).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))
    : scored;

  const shown: Finding[] = filtered.slice(0, limit).map(({ row }) => ({
    source: SOURCE,
    name: row.name,
    birth: clean(row.birth),
    event: row.out ? `выбытие: ${row.out}` : undefined,
    place: row.place || undefined,
    kind: row.kind || undefined,
    url: `${BASE}info.htm?id=${row.id}`,
  }));

  const parts = [`Всего в базе ${broad.total}, просмотрено ${rows.length}.`];
  if (query.birthYear) parts.push(`Подходят по году (${query.birthYear}±3) или без года: ${filtered.length}.`);
  if (filtered.length > shown.length) parts.push(`Показаны ${shown.length} ближайших.`);

  return { source: SOURCE, query: describe(query), searchUrl, total: broad.total, shown, note: parts.join(' ') };
}

function clean(date: string): string | undefined {
  const value = date.replace(/^__\.__\./, '').replace(/^__\./, '').trim();
  return value || undefined;
}

function describe(query: ObdQuery): string {
  return [query.lastName, query.firstName, query.patronymic].filter(Boolean).join(' ') + (query.birthYear ? `, ${query.birthYear} г. р.` : '');
}

const EXTRACT_RECORD = `[...document.querySelectorAll('.card_parameter')].map(p => [
  p.querySelector('.card_param-title')?.innerText?.trim() ?? '',
  p.querySelector('.card_param-result')?.innerText?.trim() ?? '',
]).filter(([title, value]) => title && value)`;

export type ObdRecord = { source: string; url: string; fields: Record<string, string> };

/** Opens one record card and returns its labelled fields as shown on the site. */
export async function readObdRecord(id: string): Promise<ObdRecord> {
  if (!/^\d{3,12}$/.test(id)) throw new Error('Некорректный id записи ОБД.');
  const url = `${BASE}info.htm?id=${id}`;
  return withPage(url, async page => {
    await page.waitForSelector('.card_parameter', { timeout: 20_000 }).catch(() => undefined);
    const pairs = (await page.evaluate(EXTRACT_RECORD)) as [string, string][];
    if (pairs.length === 0) throw new Error('Карточка записи не загрузилась.');
    return { source: SOURCE, url, fields: Object.fromEntries(pairs.map(([title, value]) => [title, value.replace(/^__\.__\./, '')])) };
  });
}
