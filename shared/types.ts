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
