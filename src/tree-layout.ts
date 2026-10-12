import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { Person, Provenance, Tree } from '../shared/types';

export const CARD = { width: 236, height: 68 };
const UNION = 10;

export type PersonNodeData = { person: Person; selected: boolean };

/**
 * Parents meet in a small "union" node and children hang from it, so couples sit
 * side by side and siblings share one line. Ancestors at the top.
 */
export function layoutTree(tree: Tree, selectedId: string | null): { nodes: Node[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 56, marginx: 40, marginy: 40 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const person of tree.people) graph.setNode(person.id, { ...CARD });

  const parentsOf = new Map<string, { id: string; provenance: Provenance }[]>();
  for (const r of tree.relations) {
    if (r.type !== 'parent') continue;
    parentsOf.set(r.toId, [...(parentsOf.get(r.toId) ?? []), { id: r.fromId, provenance: r.provenance }]);
  }

  const unions = new Map<string, { parents: string[]; provenance: Provenance }>();
  const edges: Edge[] = [];
  const style = (provenance: Provenance) => (provenance === 'hypothesis' ? 'hypothesis' : provenance === 'document' ? 'document' : 'told');
  const addEdge = (source: string, target: string, provenance: Provenance) => {
    edges.push({ id: `${source}->${target}`, source, target, type: 'smoothstep', className: `tree-edge ${style(provenance)}`, selectable: false });
    graph.setEdge(source, target);
  };
  const unionFor = (parents: string[], provenance: Provenance) => {
    const key = `u:${[...parents].sort().join('+')}`;
    if (!unions.has(key)) {
      unions.set(key, { parents, provenance });
      graph.setNode(key, { width: UNION, height: UNION });
      for (const parent of parents) addEdge(parent, key, provenance);
    }
    return key;
  };

  for (const [childId, parents] of parentsOf) {
    const provenance = parents.some(p => p.provenance === 'hypothesis') ? 'hypothesis' : parents[0].provenance;
    if (parents.length === 1) addEdge(parents[0].id, childId, provenance);
    else addEdge(unionFor(parents.map(p => p.id), provenance), childId, provenance);
  }
  for (const r of tree.relations) {
    if (r.type === 'spouse') unionFor([r.fromId, r.toId], r.provenance);
  }

  dagre.layout(graph);

  const nodes: Node[] = tree.people.map(person => {
    const { x, y } = graph.node(person.id);
    return {
      id: person.id,
      type: 'person',
      position: { x: x - CARD.width / 2, y: y - CARD.height / 2 },
      data: { person, selected: person.id === selectedId } satisfies PersonNodeData,
    };
  });
  for (const key of unions.keys()) {
    const { x, y } = graph.node(key);
    nodes.push({ id: key, type: 'union', position: { x: x - UNION / 2, y: y - UNION / 2 }, data: {}, selectable: false, draggable: false });
  }
  return { nodes, edges };
}

export function lifespan(person: Person): string {
  const year = (e?: Person['birth']) => (e?.year ? `${e.approximate ? '≈' : ''}${e.year}` : '');
  const birth = year(person.birth);
  const death = year(person.death);
  if (!birth && !death) return '';
  return death ? `${birth || '?'} – ${death}` : `р. ${birth}`;
}
