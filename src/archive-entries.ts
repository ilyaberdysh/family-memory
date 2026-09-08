import type { Material, MaterialKind } from '../shared/types';

export interface ArchiveEntry {
  material: Material;
  attachments: Material[];
  personIds: string[];
  kinds: MaterialKind[];
}

/** Only explicit story links make recordings attachments; snapshots remain separate entries. */
export function buildArchiveEntries(materials: Material[]): ArchiveEntry[] {
  const byId = new Map<string, Material>();
  for (const material of materials) if (!byId.has(material.id)) byId.set(material.id, material);
  const attachmentsByStory = new Map<string, Material[]>();
  const attachedIds = new Set<string>();
  for (const material of byId.values()) {
    if (material.kind !== 'story') continue;
    const attachments: Material[] = [];
    for (const id of new Set(material.relatedMaterialIds ?? [])) {
      const related = byId.get(id);
      if (!related?.file || (related.kind !== 'audio' && related.kind !== 'video')) continue;
      attachments.push(related);
      attachedIds.add(related.id);
    }
    attachmentsByStory.set(material.id, attachments);
  }
  return [...byId.values()].filter(material => !attachedIds.has(material.id)).map(material => {
    const attachments = attachmentsByStory.get(material.id) ?? [];
    const members = [material, ...attachments];
    return {
      material,
      attachments,
      personIds: [...new Set(members.flatMap(member => member.personIds))],
      kinds: [...new Set(members.map(member => member.kind))],
    };
  }).sort((a, b) => b.material.createdAt.localeCompare(a.material.createdAt));
}

export function matchesArchiveEntry(entry: ArchiveEntry, filters: { query: string; kind: 'all' | MaterialKind; personId: string | null }): boolean {
  if (filters.kind !== 'all' && !entry.kinds.includes(filters.kind)) return false;
  if (filters.personId && !entry.personIds.includes(filters.personId)) return false;
  const normalize = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru');
  const query = normalize(filters.query);
  if (!query) return true;
  return [entry.material, ...entry.attachments].some(material => normalize([
    material.title, material.body, material.narrator, material.transcript?.text ?? '', material.file?.name ?? '',
  ].join(' ')).includes(query));
}
