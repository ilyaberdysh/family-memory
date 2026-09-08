import { dateInputError, fullName, isDateFact } from '../shared/person-fields';
import { FACT_LABELS, type Fact, type Person, type Proposal } from '../shared/types';

export type ProposalIssue = { field: 'personId' | 'fromId' | 'toId' | 'personName' | 'key' | 'value'; message: string };

const normalized = (name: string) => name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
function uniquePerson(name: string | null, people: Person[]): Person | undefined {
  if (!name || !normalized(name)) return undefined;
  const matches = people.filter(person => normalized(person.name) === normalized(name));
  return matches.length === 1 ? matches[0] : undefined;
}
function resolveId(id: string | null, name: string | null, people: Person[]): string | null {
  if (id && people.some(person => person.id === id)) return id;
  return uniquePerson(name, people)?.id ?? null;
}

/** Resolve initial review selections without guessing partial names or rebasing existing targets. */
export function resolveProposal(proposal: Proposal, people: Person[], facts: Fact[]): Proposal {
  const resolved = { ...proposal };
  if (proposal.action === 'create_relation') {
    resolved.fromId = resolveId(proposal.fromId, proposal.fromName, people);
    resolved.toId = resolveId(proposal.toId, proposal.toName, people);
  } else {
    const name = proposal.action === 'create_person' && proposal.nameParts ? fullName(proposal.nameParts) : proposal.personName;
    resolved.personId = resolveId(proposal.personId, name, people);
    if (proposal.action === 'set_fact' && resolved.personId !== proposal.personId) {
      resolved.baseVersion = facts.find(fact => fact.personId === resolved.personId && fact.key === proposal.key)?.version ?? null;
    }
  }
  return resolved;
}

/** Validate accepted drafts; the server remains authoritative for writes and conflicts. */
export function validateProposal(proposal: Proposal, people: Person[], newNames: string[]): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const acceptedNames = new Set(newNames.map(normalized).filter(Boolean));
  const validId = (id: string | null) => Boolean(id && people.some(person => person.id === id));
  const reference = (id: string | null, name: string | null): string | null => {
    if (id) return validId(id) ? `id:${id}` : null;
    if (!name || !acceptedNames.has(normalized(name))) return null;
    return `name:${normalized(name)}`;
  };
  if (proposal.action === 'create_person') {
    if (proposal.personId) {
      if (!validId(proposal.personId)) issues.push({ field: 'personId', message: 'Выбранный человек больше не найден. Выберите его заново.' });
    } else if (!(proposal.nameParts ? fullName(proposal.nameParts) : proposal.personName?.trim())) {
      issues.push({ field: 'personName', message: 'Укажите имя нового человека.' });
    }
  } else if (proposal.action === 'create_relation') {
    const from = reference(proposal.fromId, proposal.fromName);
    const to = reference(proposal.toId, proposal.toName);
    if (!from) issues.push({ field: 'fromId', message: proposal.relationType === 'partner' ? 'Выберите первого партнёра или примите предложение о его создании.' : 'Выберите родителя или примите предложение о его создании.' });
    if (!to) issues.push({ field: 'toId', message: proposal.relationType === 'partner' ? 'Выберите второго партнёра или примите предложение о его создании.' : 'Выберите ребёнка или примите предложение о его создании.' });
    if (from && from === to) {
      const message = proposal.relationType === 'partner' ? 'Один человек выбран дважды. Выберите двух разных партнёров.' : 'Один человек выбран родителем и ребёнком. Выберите двух разных людей.';
      issues.push({ field: 'fromId', message }, { field: 'toId', message });
    }
  } else {
    if (!reference(proposal.personId, proposal.personName)) issues.push({ field: 'personId', message: 'Выберите человека из дерева или примите предложение о его создании.' });
    if (proposal.action === 'set_fact') {
      if (!proposal.key || !Object.hasOwn(FACT_LABELS, proposal.key)) issues.push({ field: 'key', message: 'Выберите, какое сведение добавить.' });
      const value = proposal.key === 'name' && proposal.nameParts ? fullName(proposal.nameParts) : proposal.value?.trim();
      if (!value) issues.push({ field: 'value', message: 'Укажите значение сведения.' });
      else if (proposal.key && isDateFact(proposal.key)) {
        const message = dateInputError(value);
        if (message) issues.push({ field: 'value', message });
      }
    }
  }
  return issues;
}
