import type { SearchLink } from '../../shared/types.js';
import { obdSearchUrl, type ObdQuery } from './obd-memorial.js';

/**
 * Prepared search links for sources we do not automate (security checks,
 * sign-in, or no stable search URL). The person opens them in their browser.
 */
export function searchLinks(query: ObdQuery): SearchLink[] {
  const links: SearchLink[] = [];
  const pn = new URLSearchParams({ last_name: query.lastName, adv_search: 'y' });
  if (query.firstName) pn.set('first_name', query.firstName);
  if (query.patronymic) pn.set('middle_name', query.patronymic);
  if (query.birthYear) pn.set('date_birth', String(query.birthYear));
  links.push({ source: 'Память народа', label: 'Участники войны, награды, донесения', url: `https://pamyat-naroda.ru/heroes/?${pn}`, note: 'Сайт может попросить пройти проверку.' });

  links.push({ source: 'ОБД «Мемориал»', label: 'Потери 1941–1945', url: obdSearchUrl(query) });

  const fs = new URLSearchParams({ 'q.surname': query.lastName });
  if (query.firstName) fs.set('q.givenName', query.firstName);
  if (query.birthYear) {
    fs.set('q.birthLikeDate.from', String(query.birthYear - 3));
    fs.set('q.birthLikeDate.to', String(query.birthYear + 3));
  }
  links.push({ source: 'FamilySearch', label: 'Записи и деревья', url: `https://www.familysearch.org/search/record/results?${fs}`, note: 'Нужен бесплатный аккаунт.' });

  return links;
}
