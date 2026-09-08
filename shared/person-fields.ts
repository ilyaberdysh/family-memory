import type { FactKey, NameParts } from './types';

export const EMPTY_NAME_PARTS: NameParts = { firstName: '', lastName: '', patronymic: '' };
export const NAME_PART_MAX_LENGTH = 100;
export function cleanNameParts(parts: NameParts): NameParts {
  return { firstName: parts.firstName.trim(), lastName: parts.lastName.trim(), patronymic: parts.patronymic.trim() };
}
export function fullName(parts: NameParts): string {
  const clean = cleanNameParts(parts);
  return [clean.lastName, clean.firstName, clean.patronymic].filter(Boolean).join(' ');
}
export const isDateFact = (key: FactKey) => key === 'birthDate' || key === 'deathDate';
export const DATE_INPUT_HINT = 'Полная дата — ДД.ММ.ГГГГ. Можно указать год, «около 1950» или оставить поле пустым.';

function realDate(day: number, month: number, year: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export function dateInputError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // Validate even an exact date quoted inside an otherwise approximate description.
  for (const match of value.matchAll(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g)) {
    if (!realDate(Number(match[1]), Number(match[2]), Number(match[3]))) return 'Такой даты нет в календаре. Проверьте день, месяц и год.';
  }
  for (const match of value.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
    if (!realDate(Number(match[3]), Number(match[2]), Number(match[1]))) return 'Такой даты нет в календаре. Проверьте день, месяц и год.';
  }
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  if (/^\d{4}$/.test(value)) return Number(value) > 0 ? null : 'Укажите существующий год.';
  const monthYear = /^(\d{1,2})\.(\d{4})$/.exec(value);
  if (monthYear) return Number(monthYear[1]) >= 1 && Number(monthYear[1]) <= 12 && Number(monthYear[2]) > 0 ? null : 'Проверьте месяц и год.';
  const years = /^(\d{4})\s*[–—-]\s*(\d{4})$/.exec(value);
  if (years) return Number(years[1]) > 0 && Number(years[1]) <= Number(years[2]) ? null : 'Проверьте порядок годов в диапазоне.';
  if (/^[\d\s./–—-]+$/.test(value)) return 'Введите полную дату как ДД.ММ.ГГГГ, только год или пояснение, например «около 1950».';
  // Unknown dates and lived descriptions ("лето 1987", "до войны") stay verbatim.
  return null;
}
export function formatFamilyDate(raw: string): string {
  if (dateInputError(raw)) return raw;
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  if (dotted) return `${dotted[1].padStart(2, '0')}.${dotted[2].padStart(2, '0')}.${dotted[3]}`;
  return raw;
}
