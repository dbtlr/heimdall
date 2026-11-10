import { expect, test } from 'bun:test';

import type { JumpIndex } from '../server/jump-index-types.ts';
import {
  JUMP_INDEX_FRESH_MS,
  JUMP_LIMIT,
  jumpIndexDue,
  jumpMatches,
  jumpTarget,
  moveActive,
  opensJump,
} from './jump.ts';

const session = (sessionId: string, system = 'server-1') => ({
  harness: 'claude-code',
  project: 'norn',
  sessionId,
  source: 'claude-code',
  system,
});

const index: JumpIndex = {
  projects: ['heimdall', 'norn', 'server-tools'],
  services: [
    { name: 'caddy', system: 'edge-1' },
    { name: 'postgres', system: 'db-1' },
    { name: 'server-web', system: 'server-1' },
  ],
  sessions: [session('5e7a0c'), session('a5e1b2'), session('server')],
  systems: ['db-1', 'edge-1', 'laptop-server', 'server-1', 'server-2'],
};

const labels = (query: string, limit?: number) =>
  jumpMatches(index, query, limit).map((item) =>
    item.kind === 'session' ? `session ${item.sessionId}` : `${item.kind} ${item.name}`,
  );

test('an empty query matches nothing', () => {
  expect(labels('')).toEqual([]);
  expect(labels('   ')).toEqual([]);
});

test('kinds come in order, Systems, Services, projects, Sessions, and within a kind a prefix match leads', () => {
  expect(labels('SERVER')).toEqual([
    'system server-1',
    'system server-2',
    'system laptop-server',
    'service server-web',
    'project server-tools',
    'session server',
  ]);
});

test('a Session matches only by the prefix of its id', () => {
  expect(labels('5e')).toEqual(['session 5e7a0c']);
  expect(labels('e1b2')).toEqual([]);
});

test('spaces around a query are ignored', () => {
  expect(labels('  norn ')).toEqual(['project norn']);
  expect(labels(' 5e7a ')).toEqual(['session 5e7a0c']);
});

test('names match ignoring case, the name and the query alike', () => {
  const mixed = { ...index, projects: ['MyApp'], services: [{ name: 'Caddy', system: 'Edge-1' }] };
  const found = (query: string) =>
    jumpMatches(mixed, query).map((item) => (item.kind === 'session' ? item.sessionId : item.name));
  expect(found('myapp')).toEqual(['MyApp']);
  expect(found('app')).toEqual(['MyApp']);
  expect(found('caddy')).toEqual(['Caddy']);
});

test('no match is an empty list', () => {
  expect(labels('zzz')).toEqual([]);
});

test('results stop at the cap, keeping the first in order', () => {
  expect(labels('e')).toHaveLength(8);
  expect(labels('e', 3)).toEqual(['system edge-1', 'system laptop-server', 'system server-1']);
  const many = { ...index, systems: Array.from({ length: 40 }, (_, at) => `node-${String(at)}`) };
  expect(jumpMatches(many, 'node')).toHaveLength(JUMP_LIMIT);
});

test('each kind opens its own page', () => {
  expect(jumpTarget({ kind: 'system', name: 'server-1' })).toEqual({
    params: { name: 'server-1' },
    to: '/systems/$name',
  });
  expect(jumpTarget({ kind: 'service', name: 'caddy', system: 'edge-1' })).toEqual({
    params: { name: 'edge-1', service: 'caddy' },
    to: '/systems/$name/services/$service',
  });
  expect(jumpTarget({ kind: 'project', name: 'norn' })).toEqual({
    search: { by: 'project', pick: 'norn', range: '30d' },
    to: '/agents',
  });
  expect(jumpTarget({ kind: 'session', ...session('5e7a0c') })).toEqual({
    params: {
      harness: 'claude-code',
      name: 'server-1',
      sessionId: '5e7a0c',
      source: 'claude-code',
    },
    to: '/systems/$name/sessions/$harness/$source/$sessionId',
  });
});

test('arrow keys move through the results and wrap at either end', () => {
  expect(moveActive(undefined, 3, 'ArrowDown')).toBe(0);
  expect(moveActive(undefined, 3, 'ArrowUp')).toBe(2);
  expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
  expect(moveActive(0, 3, 'ArrowUp')).toBe(2);
  expect(moveActive(1, 3, 'ArrowDown')).toBe(2);
  expect(moveActive(undefined, 0, 'ArrowDown')).toBeUndefined();
});

const key = (over: Partial<Parameters<typeof opensJump>[0]> = {}) => ({
  altKey: false,
  ctrlKey: false,
  key: '/',
  metaKey: false,
  target: { isContentEditable: false, tagName: 'BODY' },
  ...over,
});

test('slash opens the jump box unless a modifier is held or something editable has focus', () => {
  expect(opensJump(key())).toBe(true);
  expect(opensJump(key({ target: { isContentEditable: false, tagName: 'A' } }))).toBe(true);
  expect(opensJump(key({ key: 'k' }))).toBe(false);
  expect(opensJump(key({ ctrlKey: true }))).toBe(false);
  expect(opensJump(key({ metaKey: true }))).toBe(false);
  expect(opensJump(key({ altKey: true }))).toBe(false);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    expect(opensJump(key({ target: { isContentEditable: false, tagName } }))).toBe(false);
  }
  expect(opensJump(key({ target: { isContentEditable: true, tagName: 'DIV' } }))).toBe(false);
  expect(opensJump(key({ target: null }))).toBe(true);
});

test('the jump index is read again only once the held one is a minute old', () => {
  expect(jumpIndexDue(undefined, 1000)).toBe(true);
  expect(jumpIndexDue(1000, 1000 + JUMP_INDEX_FRESH_MS - 1)).toBe(false);
  expect(jumpIndexDue(1000, 1000 + JUMP_INDEX_FRESH_MS)).toBe(true);
});
