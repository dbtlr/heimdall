import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, storeToken, timeline } from '@heimdall/hub/testing';

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

test('the jump index names every System, each paired Service with its System, and the projects and Sessions of 30 days by their last working directory, newest Session first', async () => {
  await using h = await startHub();
  const heard = await push(
    h.hub,
    { ...report('server-1', [NOW]), records: records(['web', 'api']) },
    { token: 'server-token' },
  );
  expect(heard.status).toBe(200);
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1'), ('retired-1')`;
  // Paired, with no Report yet, so the Hub keeps no history of it.
  await storeToken(h.db.sql, { pairedAt: NOW, system: 'edge-1', token: 'edge-token' });
  await addSession(h.db.sql, {
    firstCwd: '/home/someone/work/scratch',
    id: 'older',
    lastCwd: '/home/someone/work/norn',
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
    systems: ['edge-1', 'laptop-1', 'retired-1', 'server-1'],
  });
});

test('the jump index offers only projects with a request in the 30 days, the ones the Agents page can pick', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await addSession(h.db.sql, {
    firstCwd: '/home/someone/work/fleet',
    id: 'busy',
    requests: [-60],
    system: 'server-1',
  });
  // Its last request is older than the window; its transcript ran on into it.
  await addSession(h.db.sql, {
    firstCwd: '/home/someone/work/trailing',
    id: 'trail',
    requests: [-31 * DAY_S],
    system: 'server-1',
  });
  await h.db.sql`
    UPDATE projected_sessions SET ended_at = ${new Date(NOW - 29 * DAY_S * 1000)}
    WHERE session_id = 'trail'
  `;
  // A transcript inside the window with no request at all.
  await h.db.sql`
    INSERT INTO projected_sessions (
      harness, parser_version, system, source, session_id, path, started_at, ended_at,
      first_cwd, last_cwd
    )
    VALUES ('claude-code', 1, 'server-1', 'claude-code', 'quiet', 'projects/p/quiet.jsonl',
            ${new Date(NOW - DAY_S * 1000)}, ${new Date(NOW - DAY_S * 1000)},
            '/home/someone/work/lonely', '/home/someone/work/lonely')
  `;

  const index = await readJumpIndex(h.db.sql, { now: NOW });

  expect(index.projects).toEqual(['fleet']);
  expect(index.sessions.map(({ sessionId }) => sessionId)).toEqual(['busy', 'quiet', 'trail']);
});
