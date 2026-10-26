import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Person, Relation, Tree, TreeState } from '../shared/types.js';

/**
 * Local single-user store: one JSON file with the tree and an undo stack.
 * Enough for the local stand; moves to Postgres once accounts exist.
 */
type File = Tree & { history: { label: string; before: Tree }[] };
export type TreeStoreSnapshot = { exists: boolean; content?: string };

const HISTORY_LIMIT = 100;

function filePath(): string {
  return path.join(path.resolve(process.env.DATA_DIR ?? 'data'), 'tree.json');
}

function read(): File {
  const file = filePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<File>;
    if (!Array.isArray(parsed.people) || !Array.isArray(parsed.relations)) throw new Error('tree.json повреждён: people и relations должны быть списками.');
    return { people: parsed.people, relations: parsed.relations, history: Array.isArray(parsed.history) ? parsed.history : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { people: [], relations: [], history: [] };
    throw error;
  }
}

function write(file: File) {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(file, null, 2));
  fs.renameSync(temp, target);
}

export function snapshotTreeStore(): TreeStoreSnapshot {
  const target = filePath();
  try {
    return { exists: true, content: fs.readFileSync(target, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

export function restoreTreeStore(snapshotValue: TreeStoreSnapshot): void {
  const target = filePath();
  if (!snapshotValue.exists) {
    fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.restore.tmp`;
  fs.writeFileSync(temp, snapshotValue.content ?? '');
  fs.renameSync(temp, target);
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
