import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Person, Relation, Tree, TreeState } from '../shared/types.js';

/**
 * Local single-user store: one JSON file with the tree and an undo stack.
 * Enough for the local stand; moves to Postgres once accounts exist.
 */
type File = Tree & { history: { label: string; before: Tree }[] };

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const FILE = path.join(DATA_DIR, 'tree.json');
const HISTORY_LIMIT = 100;

function read(): File {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as File;
  } catch {
    return { people: [], relations: [], history: [] };
  }
}

function write(file: File) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(file, null, 2));
  fs.renameSync(temp, FILE);
}

function snapshot(file: File): Tree {
  return structuredClone({ people: file.people, relations: file.relations });
}

export function getTree(): TreeState {
  const file = read();
  return { people: file.people, relations: file.relations, canUndo: file.history.length > 0, lastChange: file.history.at(-1)?.label };
}

/** Applies a mutation as one undoable step. The mutation may throw to abort. */
export function change<T>(label: string, mutate: (tree: Tree) => T): T {
  const file = read();
  const before = snapshot(file);
  const result = mutate(file);
  file.history = [...file.history, { label, before }].slice(-HISTORY_LIMIT);
  write(file);
  return result;
}

export function undo(): TreeState {
  const file = read();
  const last = file.history.pop();
  if (last) {
    file.people = last.before.people;
    file.relations = last.before.relations;
    write(file);
  }
  return getTree();
}

export function resetTree(): TreeState {
  change('Древо очищено', tree => {
    tree.people = [];
    tree.relations = [];
  });
  return getTree();
}

export function newPerson(input: Omit<Person, 'id' | 'createdAt'>): Person {
  return { ...input, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
}

export function newRelation(input: Omit<Relation, 'id'>): Relation {
  return { ...input, id: randomUUID().slice(0, 8) };
}

export function deletePerson(id: string): TreeState {
  change('Человек удалён', tree => {
    const person = tree.people.find(p => p.id === id);
    if (!person) throw new Error('Человек не найден.');
    tree.people = tree.people.filter(p => p.id !== id);
    tree.relations = tree.relations.filter(r => r.fromId !== id && r.toId !== id);
  });
  return getTree();
}
