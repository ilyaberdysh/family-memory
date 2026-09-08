import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchiveEntries, matchesArchiveEntry } from '../src/archive-entries';
import type { Material, MaterialKind } from '../shared/types';

const material = (id: string, kind: MaterialKind, changes: Partial<Material> = {}): Material => ({
  id, kind, title: 'Название материала', body: '', narrator: '', occurredAt: '', personIds: [],
  file: null, createdBy: 'test', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '', version: 1,
  transcriptionStatus: 'idle', extractionStatus: 'idle', processingError: null, ...changes,
});
const file = (id: string) => ({ id, name: `${id}.webm`, mime: 'audio/webm', size: 12, url: `/api/files/${id}` });
const filters = { query: '', kind: 'all' as const, personId: '' };

test('a story retains its ID and recording order while search, people and kinds cover the full entry', () => {
  const story = material('story', 'story', { body: 'Воспоминание о доме', personIds: ['p1'], relatedMaterialIds: ['video', 'audio'] });
  const audio = material('audio', 'audio', { file: file('voice'), narrator: 'Рассказчица', personIds: ['p2', 'p1'],
    transcript: { text: 'Отдыхали на Волге', segments: [], version: 1, automatic: true, updatedAt: '' } });
  const video = material('video', 'video', { file: { ...file('clip'), mime: 'video/webm' }, title: 'Семейный праздник' });
  const [entry] = buildArchiveEntries([audio, story, video]);
  assert.equal(entry.material, story);
  assert.deepEqual(entry.attachments.map(item => item.id), ['video', 'audio']);
  assert.deepEqual(entry.personIds, ['p1', 'p2']);
  assert.deepEqual(entry.kinds, ['story', 'video', 'audio']);
  for (const query of ['ДОМЕ', 'праздник', 'Рассказчица', ' НА   ВОЛГЕ ', 'voice.webm']) {
    assert.equal(matchesArchiveEntry(entry, { ...filters, query }), true);
  }
  for (const kind of ['story', 'audio', 'video'] as const) assert.equal(matchesArchiveEntry(entry, { ...filters, kind, personId: 'p2' }), true);
  assert.equal(matchesArchiveEntry(entry, { ...filters, kind: 'photo' }), false);
  assert.equal(matchesArchiveEntry(entry, { ...filters, personId: 'missing' }), false);
  assert.equal(matchesArchiveEntry(entry, { ...filters, query: 'Несуществующий текст' }), false);
});

test('standalone, missing-file and unsupported linked materials stay visible; duplicate attachment IDs are removed', () => {
  const audio = material('audio', 'audio', { file: file('audio') });
  const noFile = material('no-file', 'audio');
  const photo = material('photo', 'photo', { file: { ...file('photo'), mime: 'image/jpeg' } });
  const standalone = material('standalone', 'audio', { file: file('standalone'), relatedMaterialIds: ['photo'] });
  const story = material('story', 'story', { relatedMaterialIds: ['missing', 'audio', 'audio', 'no-file', 'photo', 'story'] });
  const emptyStory = material('empty-story', 'story', { relatedMaterialIds: ['missing'] });
  const entries = buildArchiveEntries([story, audio, noFile, photo, standalone, emptyStory]);
  assert.deepEqual(entries.map(entry => entry.material.id), ['story', 'no-file', 'photo', 'standalone', 'empty-story']);
  assert.deepEqual(entries[0].attachments.map(item => item.id), ['audio']);
  assert.deepEqual(entries.at(-1)?.attachments, []);
  assert.deepEqual(story.relatedMaterialIds, ['missing', 'audio', 'audio', 'no-file', 'photo', 'story']);
  assert.deepEqual(buildArchiveEntries([]), []);
});

test('distinct snapshots and similar standalone materials remain separate; shared attachments belong to each explicit story', () => {
  const audio = material('audio', 'audio', { file: file('shared') });
  const oldStory = material('old', 'story', { relatedMaterialIds: ['audio'], createdAt: '2026-09-01T00:00:00.000Z' });
  const newStory = material('new', 'story', { relatedMaterialIds: ['audio'], createdAt: '2026-09-03T00:00:00.000Z' });
  const standalone = material('standalone', 'audio', { file: file('shared'), createdAt: '2026-09-02T00:00:00.000Z' });
  const input = [oldStory, audio, newStory, standalone];
  const entries = buildArchiveEntries(input);
  assert.deepEqual(entries.map(entry => entry.material.id), ['new', 'standalone', 'old']);
  assert.deepEqual(entries[0].attachments, [audio]);
  assert.deepEqual(entries[2].attachments, [audio]);
  assert.deepEqual(entries[1].attachments, []);
  assert.deepEqual(input.map(item => item.id), ['old', 'audio', 'new', 'standalone']);
});
