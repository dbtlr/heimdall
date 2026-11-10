import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';

import { readJumpIndex } from './jump-index.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const { addSession } = timeline(NOW);
const DAY_S = 86_400;

const records = (names: string[]) => ({
  records: names.map((name) => ({
    kind: 'service',
    name,
    record: { name, supervisor: 'systemd', unit: `${name}.service` },
  })),
  unreadable: [],
});

test('the jump index names every System, each paired Service with its System, and the projects and Sessions of 30 days, newest Session first', async () => {
  await using h = await startHub();
  const heard = await push(
    h.hub,
    { ...report('server-1', [NOW]), records: records(['web', 'api']) },
    { token: 'server-token' },
  );
  expect(heard.status).toBe(200);
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1'), ('retired-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/home/someone/work/norn',
    id: 'older',
    requests: [-2 * DAY_S],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    firstCwd: '/home/someone/work/fleet',
    harness: 'codex',
    id: 'newer',
    requests: [-60],
    system: 'laptop-1',
  });
  await addSession(h.db.sql, {
    firstCwd: '/home/someone/work/ancient',
    id: 'stale',
    requests: [-31 * DAY_S],
    system: 'server-1',
  });

  const index = await readJumpIndex(h.db.sql, { now: NOW });

  expect(index).toEqual({
    projects: ['fleet', 'norn'],
    services: [
      { name: 'api', system: 'server-1' },
      { name: 'web', system: 'server-1' },
    ],
    sessions: [
      {
        harness: 'codex',
        project: 'fleet',
        sessionId: 'newer',
        source: 'codex',
        system: 'laptop-1',
      },
      {
        harness: 'claude-code',
        project: 'norn',
        sessionId: 'older',
        source: 'claude-code',
        system: 'server-1',
      },
    ],
    systems: ['laptop-1', 'retired-1', 'server-1'],
  });
});
