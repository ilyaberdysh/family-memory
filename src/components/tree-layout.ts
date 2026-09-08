import dagre from '@dagrejs/dagre';
import type { Person, Relation } from '../../shared/types';

export const PERSON_WIDTH = 196;
export const PERSON_HEIGHT = 76;
const BRANCH_GAP = 52;
type Point = { x: number; y: number };
type LayoutPerson = Pick<Person, 'id'>;
type LayoutRelation = Pick<Relation, 'id' | 'fromId' | 'toId' | 'type'>;
type Group = { id: string; members: string[]; width: number; offsets: Map<string, number>; x: number; y: number };

/** Partner grouping controls placement only. Edges always come from saved relations. */
export function layoutFamily(people: LayoutPerson[], relations: LayoutRelation[]): Map<string, Point> {
  if (!people.length) return new Map();
  const ids = new Set(people.map(person => person.id));
  const links = relations.filter(relation => ids.has(relation.fromId) && ids.has(relation.toId));
  const parents = new Map(people.map(person => [person.id, [] as string[]]));
  const children = new Map(people.map(person => [person.id, [] as string[]]));
  const representative = new Map(people.map(person => [person.id, person.id]));
  const find = (id: string): string => {
    const next = representative.get(id)!;
    if (next === id) return id;
    const root = find(next); representative.set(id, root); return root;
  };
  for (const relation of links) {
    if (relation.type === 'partner') representative.set(find(relation.fromId), find(relation.toId));
    else {
      if (!parents.get(relation.toId)!.includes(relation.fromId)) parents.get(relation.toId)!.push(relation.fromId);
      if (!children.get(relation.fromId)!.includes(relation.toId)) children.get(relation.fromId)!.push(relation.toId);
    }
  }

  // Each spouse retains their own ancestral space; collapsing a couple to one
  // attachment point is what placed maternal ancestors over the paternal branch.
  const widths = new Map<string, number>();
  const visiting = new Set<string>();
  const branchWidth = (id: string): number => {
    if (widths.has(id)) return widths.get(id)!;
    if (visiting.has(id)) return PERSON_WIDTH;
    visiting.add(id);
    const ancestors = parents.get(id)!;
    const width = Math.min(people.length * (PERSON_WIDTH + BRANCH_GAP), Math.max(PERSON_WIDTH,
      ancestors.reduce((sum, parentId) => sum + branchWidth(parentId), 0) + Math.max(0, ancestors.length - 1) * BRANCH_GAP));
    visiting.delete(id); widths.set(id, width); return width;
  };
  const grouped = new Map<string, string[]>();
  for (const person of people) {
    const id = find(person.id);
    grouped.set(id, [...(grouped.get(id) || []), person.id]);
  }
  const groups: Group[] = [...grouped].map(([id, members]) => {
    const width = members.reduce((sum, member) => sum + branchWidth(member), 0) + (members.length - 1) * BRANCH_GAP;
    let cursor = -width / 2;
    const offsets = new Map<string, number>();
    for (const member of members) {
      const cellWidth = branchWidth(member);
      offsets.set(member, cursor + cellWidth / 2); cursor += cellWidth + BRANCH_GAP;
    }
    return { id, members, width, offsets, x: 0, y: 0 };
  });
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', nodesep: BRANCH_GAP, ranksep: 110, marginx: 48, marginy: 64 });
  for (const group of groups) graph.setNode(group.id, { width: group.width, height: PERSON_HEIGHT });
  for (const relation of links) {
    if (relation.type !== 'parent') continue;
    const from = find(relation.fromId), to = find(relation.toId);
    if (from !== to) graph.setEdge(from, to);
  }
  dagre.layout(graph);
  const byId = new Map(groups.map(group => [group.id, group]));
  const rows = new Map<number, Group[]>();
  for (const group of groups) {
    const point = graph.node(group.id);
    group.x = point.x; group.y = point.y;
    rows.set(group.y, [...(rows.get(group.y) || []), group]);
  }
  for (const [, row] of [...rows].sort(([a], [b]) => b - a)) {
    const desired = new Map<string, number>();
    for (const group of row) {
      const anchors: number[] = [];
      for (const member of group.members) for (const child of children.get(member)!) {
        const childGroup = byId.get(find(child))!;
        if (childGroup.y <= group.y) continue;
        anchors.push(childGroup.x + childGroup.offsets.get(child)! - group.offsets.get(member)!);
      }
      desired.set(group.id, anchors.length ? anchors.reduce((sum, x) => sum + x, 0) / anchors.length : group.x);
    }
    row.sort((a, b) => desired.get(a.id)! - desired.get(b.id)! || a.x - b.x);
    // Fit ordered centers to their child anchors with a minimum gap (isotonic
    // regression). A crowded pair shifts together; unrelated branches stay put.
    const offsets: number[] = [];
    const blocks: { start: number; end: number; sum: number; count: number }[] = [];
    row.forEach((group, index) => {
      offsets[index] = index ? offsets[index - 1] + row[index - 1].width / 2 + BRANCH_GAP + group.width / 2 : 0;
      blocks.push({ start: index, end: index, sum: desired.get(group.id)! - offsets[index], count: 1 });
      while (blocks.length > 1) {
        const right = blocks.at(-1)!, left = blocks.at(-2)!;
        if (left.sum / left.count <= right.sum / right.count) break;
        blocks.splice(-2, 2, { start: left.start, end: right.end, sum: left.sum + right.sum, count: left.count + right.count });
      }
    });
    for (const block of blocks) for (let index = block.start; index <= block.end; index++) {
      row[index].x = offsets[index] + block.sum / block.count;
    }
  }
  const positions = new Map<string, Point>();
  for (const group of groups) for (const member of group.members) positions.set(member, {
    x: group.x + group.offsets.get(member)! - PERSON_WIDTH / 2,
    y: group.y - PERSON_HEIGHT / 2,
  });
  return positions;
}

export function relationPorts(id: string, relations: LayoutRelation[], positions: Map<string, Point>, direction: 'source' | 'target') {
  const relevant = relations.filter(relation => relation.type === 'parent' && (direction === 'source' ? relation.fromId : relation.toId) === id);
  relevant.sort((a, b) => (positions.get(direction === 'source' ? a.toId : a.fromId)?.x || 0) - (positions.get(direction === 'source' ? b.toId : b.fromId)?.x || 0) || a.id.localeCompare(b.id));
  return relevant.map((relation, index) => ({ id: `${direction}-${relation.id}`, offset: (index + 1) * 100 / (relevant.length + 1) }));
}
