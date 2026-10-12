/** Where a fact came from. Every person and relation carries one. */
export type Provenance = 'told' | 'document' | 'hypothesis';

export type LifeEvent = {
  year?: number;
  approximate?: boolean;
  place?: string;
};

export type Person = {
  id: string;
  name: string;
  sex?: 'male' | 'female';
  birth?: LifeEvent;
  death?: LifeEvent;
  note?: string;
  provenance: Provenance;
  source?: string;
  createdAt: string;
};

export type Relation = {
  id: string;
  type: 'parent' | 'spouse';
  /** For 'parent': the parent. For 'spouse': either partner. */
  fromId: string;
  /** For 'parent': the child. */
  toId: string;
  provenance: Provenance;
  source?: string;
};

export type Tree = {
  people: Person[];
  relations: Relation[];
};

export type TreeState = Tree & { canUndo: boolean; lastChange?: string };

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  told: 'со слов',
  document: 'документ',
  hypothesis: 'гипотеза',
};

/** One candidate record found in an external source. Never a confirmed fact by itself. */
export type Finding = {
  source: string;
  name: string;
  birth?: string;
  event?: string;
  place?: string;
  kind?: string;
  url: string;
};

export type SearchResult = {
  source: string;
  query: string;
  searchUrl: string;
  total: number;
  shown: Finding[];
  note?: string;
};

export type SearchLink = { source: string; label: string; url: string; note?: string };
