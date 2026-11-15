import { expect, test } from 'bun:test';

import { NOW, push, report, startHub } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { hubVerdict } from '../components/hub-status.tsx';
import { phraseText } from '../lib/phrase.ts';
import type { Phrase } from '../lib/phrase.ts';
import type { HubStatus } from './hub-status-types.ts';
import { readHubStatus, readHubVersion } from './hub-status.ts';

const ZONE = 'UTC';
const text = (phrase: Phrase | undefined) => (phrase === undefined ? '' : phraseText(phrase, ZONE));
const row = (status: HubStatus, part: string) => {
  const found = status.checks.find((c) => c.part === part);
  return { detail: text(found?.detail), state: found?.state, text: text(found?.text) };
};
const tableOf = (status: HubStatus, title: string) =>
  [...status.tables, ...status.details].find((t) => t.title === title);

// The schedules serve records (PASS_SCHEDULES in packages/hub/src/serve.ts).
const SCHEDULES = {
  conditions: { budget_ms: 30_000, interval_ms: 60_000 },
  delivery: { budget_ms: 30_000, interval_ms: 30_000 },
  listening: { budget_ms: 30_000, interval_ms: 30_000 },
  parse: { budget_ms: 30_000, interval_ms: 15_000 },
  prune: { budget_ms: 30_000, interval_ms: 3_600_000 },
  refresh: { budget_ms: 40_000, interval_ms: 15_000 },
  upstreams: { budget_ms: 30_000, interval_ms: 300_000 },
};

// A Hub that started a minute before NOW and whose every pass ran at NOW,
// with both test Systems reporting.
const runningHub = async (
  h: Hub,
  { delivery = true, runs = {} }: { delivery?: boolean; runs?: Record<string, object> } = {},
) => {
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  const lastRuns = Object.fromEntries(
    Object.entries(SCHEDULES)
      .filter(([name]) => delivery || name !== 'delivery')
      .map(([name, schedule]) => [
        name,
        { ...schedule, finished_at: NOW, started_at: NOW - 100, succeeded_at: NOW, ...runs[name] },
      ]),
  );
  await h.db.sql`INSERT INTO hub_status (version, started_at, delivery_configured, last_runs)
    VALUES ('1.2.3', ${new Date(NOW - 60_000)}, ${delivery}, ${h.db.sql.json(lastRuns)}::jsonb)`;
  await h.db
    .sql`UPDATE hub_listening SET heard_at = ${new Date(NOW)}, listening_since = ${new Date(NOW - 86_400_000)}`;
};

const raise = (h: Hub, system: string, kind: string, level: string, subject = '') =>
  h.db
    .sql`INSERT INTO conditions (system, kind, subject, level, raised_at, raised_reason, latest_at, latest_reason)
    VALUES (${system}, ${kind}, ${subject}, ${level}, ${new Date(NOW)}, 'test', ${new Date(NOW)}, 'test')`;

test('an older Hub without the status table asks for an upgrade; a fresh database does not', async () => {
  await using h = await startHub();
  const fresh = await readHubStatus(h.db.sql, NOW);
  expect(fresh.runtime).toBe('empty');
  expect(text(hubVerdict(fresh).summary)).not.toContain('Upgrade');
  await h.db.sql`DROP TABLE hub_status`;
  const older = await readHubStatus(h.db.sql, NOW);
  expect(older.runtime).toBe('missing');
  expect(older.version).toBeUndefined();
  expect(await readHubVersion(h.db.sql)).toBeUndefined();
  expect(text(hubVerdict(older).summary)).toContain('Upgrade the Hub');
});

test('a running Hub with every pass current reads all well, with local times and no raw stamps', async () => {
  await using h = await startHub();
  await runningHub(h);
  const status = await readHubStatus(h.db.sql, NOW + 12_000);
  expect(status.checks.filter((c) => c.state !== 'ok')).toEqual([]);
  expect(hubVerdict(status).verdict).toBe('All well');
  expect(await readHubVersion(h.db.sql)).toBe('1.2.3');
  expect(row(status, 'Listening').text).toBe('Since Mon 12:00, last recorded 12 s ago');
  expect(row(status, 'Intake').text).toBe('2 Systems paired · none stale');
  expect(row(status, 'Stored Session totals').text).toMatch(
    /^0 Sessions waiting to refresh · \d+ ranges? · 0 rederiving · no refresh retries$/u,
  );
  expect(row(status, 'Session insight').text).toBe('Read through · 0 failed');
  expect(row(status, 'Conditions').text).toBe('Condition evaluation ran 12 s ago');
  expect(JSON.stringify(status)).not.toMatch(/\d{4}-\d\d-\d\dT|UTC/u);
  expect(tableOf(status, 'Systems and Collectors')?.columns[1]).toBe('Last seen');
});

test('intake counts the open Stale System Conditions, not its own quiet rule', async () => {
  await using h = await startHub();
  await runningHub(h);
  // Quiet for a day with no Condition, as during pairing grace or after an outage.
  await h.db.sql`UPDATE systems SET last_seen_at = ${new Date(NOW - 86_400_000)}`;
  expect(row(await readHubStatus(h.db.sql, NOW), 'Intake').state).toBe('ok');
  await raise(h, 'laptop-1', 'system_stale', 'warning');
  const stale = row(await readHubStatus(h.db.sql, NOW), 'Intake');
  expect(stale).toEqual({
    detail: 'laptop-1 last seen 1 d ago',
    state: 'warning',
    text: '2 Systems paired · 1 stale',
  });
});

test('upstream checks count only upstreams a System records now, and name each failing one', async () => {
  await using h = await startHub();
  await runningHub(h);
  await h.db.sql`INSERT INTO upstream_checks (upstream, checked_at, next_check_at, failure)
    VALUES ('github:example/forgotten', ${new Date(NOW - 60_000)}, ${new Date(NOW + 60_000)}, 'HTTP 404')`;
  expect(row(await readHubStatus(h.db.sql, NOW), 'Upstream checks')).toMatchObject({
    state: 'ok',
    text: '0 of 0 upstreams checked · none failing',
  });
  await h.db.sql`INSERT INTO mirrored_records (system, kind, name, record)
    VALUES ('server-1', 'service', 'tool', '{}'), ('server-1', 'service', 'other', '{}')`;
  await h.db.sql`INSERT INTO service_versions (system, service, version, upstream, first_seen_at)
    VALUES ('server-1', 'tool', '1.0', 'github:example/tool', ${new Date(NOW)}),
      ('server-1', 'other', '1.0', 'github:example/other', ${new Date(NOW)})`;
  await h.db.sql`INSERT INTO upstream_checks (upstream, checked_at, next_check_at, failure)
    VALUES ('github:example/tool', ${new Date(NOW - 60_000)}, ${new Date(NOW + 3_600_000)}, 'HTTP 503')`;
  expect(row(await readHubStatus(h.db.sql, NOW), 'Upstream checks')).toEqual({
    detail: 'github:example/tool HTTP 503, checked 11:59, next try 13:00',
    state: 'warning',
    text: '1 of 2 upstreams checked · 1 failing',
  });
});

test('alert delivery warns only once Home would, and counts the alerts not pushed', async () => {
  await using h = await startHub();
  await runningHub(h);
  await raise(h, 'server-1', 'service_down', 'alert', 'nginx');
  await h.db.sql`UPDATE delivery_status SET failing_since = ${new Date(NOW - 60_000)}`;
  expect(row(await readHubStatus(h.db.sql, NOW), 'Alert delivery').state).toBe('ok');
  await h.db.sql`UPDATE delivery_status SET failing_since = ${new Date(NOW - 18 * 60_000)}`;
  const failing = await readHubStatus(h.db.sql, NOW);
  expect(row(failing, 'Alert delivery')).toMatchObject({
    state: 'warning',
    text: 'Failing since 11:42 (18 min) · 1 alert not pushed',
  });
  expect(hubVerdict(failing)).toEqual({
    summary: ['Alert delivery needs attention. Everything else is current.'],
    verdict: '1 needs a look',
  });
});

test('a Hub that stopped says so once, and no pass it left behind warns on its own', async () => {
  await using h = await startHub();
  await runningHub(h);
  const later = NOW + 3 * 3_600_000;
  const status = await readHubStatus(h.db.sql, later);
  expect(text(status.down)).toBe('The Hub is not running: last heard 12:00, 3 h ago.');
  expect(hubVerdict(status).verdict).toBe('Hub not running');
  expect(row(status, 'Listening')).toMatchObject({
    state: 'warning',
    text: 'Not running: last heard 12:00',
  });
  expect(status.checks.filter((c) => c.state === 'warning').map((c) => c.part)).toEqual([
    'Listening',
  ]);
  expect(row(status, 'Conditions').text).toBe('Condition evaluation last ran 3 h ago');
});

test('a pass that keeps failing reads as failing, and one still running says for how long', async () => {
  await using h = await startHub();
  await runningHub(h, {
    runs: {
      conditions: { failing_since: NOW - 5 * 60_000, succeeded_at: NOW - 6 * 60_000 },
      parse: { finished_at: NOW - 60_000, started_at: NOW - 40_000 },
    },
  });
  const status = await readHubStatus(h.db.sql, NOW);
  expect(row(status, 'Conditions')).toMatchObject({
    state: 'warning',
    text: 'Condition evaluation failing since 11:55 (5 min)',
  });
  expect(row(status, 'Session insight')).toMatchObject({
    detail: 'Parse pass running for 40 s',
    state: 'ok',
  });
});

test('an overdue pass warns, and a stalled rebuild says so', async () => {
  await using h = await startHub();
  await runningHub(h);
  await h.db.sql`INSERT INTO current_parsers VALUES ('codex', 1)`;
  await h.db
    .sql`INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
    VALUES (1, 'server-1', 'codex', 'session.jsonl', ${new Date(NOW)}, ${new Date(NOW)})`;
  await h.db
    .sql`INSERT INTO parse_progress (harness, parser_version, generation, parsed_through, held_seen) VALUES ('codex', 2, 1, 0, 0)`;
  await h.db.sql`UPDATE hub_listening SET heard_at = ${new Date(NOW + 100_000)}`;
  const status = await readHubStatus(h.db.sql, NOW + 100_000);
  expect(row(status, 'Session insight')).toMatchObject({
    detail: 'Parser rebuild stalled: Parse pass overdue: last started 1 min ago',
    state: 'warning',
  });
  expect(row(status, 'Session insight').text).toContain('Codex parser rebuilding to v2');
  expect(row(status, 'Conditions').state).toBe('ok');
});

test('parser failures and refresh retries are counted in the singular, never with failure text', async () => {
  await using h = await startHub();
  await runningHub(h);
  const [g] = await h.db
    .sql`INSERT INTO transcript_generations (id, system, source, path, held, opened_at, last_upload_at)
    VALUES (1, 'server-1', 'codex', 'session.jsonl', 100, ${new Date(NOW)}, ${new Date(NOW)}) RETURNING id`;
  await h.db.sql`INSERT INTO current_parsers VALUES ('codex', 1)`;
  await h.db
    .sql`INSERT INTO parse_progress (harness, parser_version, generation, parsed_through, held_seen, failed_attempts, failed_at, failure)
    VALUES ('codex', 2, ${g.id}, 20, 100, 3, ${new Date(NOW)}, 'SECRET TRANSCRIPT CONTENT')`;
  await h.db
    .sql`INSERT INTO stale_sessions VALUES ('codex', 'server-1', 'codex', 's1', true, true, 3)`;
  await h.db.sql`INSERT INTO rederiving_sessions VALUES ('codex', 'server-1', 'codex', 's1')`;
  const status = await readHubStatus(h.db.sql, NOW);
  expect(row(status, 'Session insight').text).toContain('1 generation failed');
  expect(row(status, 'Stored Session totals').text).toMatch(
    /^1 Session waiting to refresh · \d+ ranges? · 1 rederiving · 1 refresh retry$/u,
  );
  expect(tableOf(status, 'Session insight')?.notes.map(text)).toEqual([
    'Failed generation: server-1, source codex, 3 attempts, failed 12:00.',
    'The reason is kept out of the dashboard.',
  ]);
  expect(JSON.stringify(status)).not.toContain('SECRET TRANSCRIPT CONTENT');
});

test('a growing list of failed generations stops at three and says how many more', async () => {
  await using h = await startHub();
  await runningHub(h);
  await h.db.sql`INSERT INTO current_parsers VALUES ('codex', 1)`;
  for (const id of [1, 2, 3, 4, 5]) {
    // oxlint-disable-next-line no-await-in-loop -- one generation after another.
    await h.db
      .sql`INSERT INTO transcript_generations (id, system, source, path, held, opened_at, last_upload_at)
      VALUES (${id}, 'server-1', ${`s${String(id)}`}, 'session.jsonl', 100, ${new Date(NOW)}, ${new Date(NOW)})`;
    // oxlint-disable-next-line no-await-in-loop -- one generation after another.
    await h.db
      .sql`INSERT INTO parse_progress (harness, parser_version, generation, parsed_through, held_seen, failed_attempts, failed_at, failure)
      VALUES ('codex', 1, ${id}, 0, 100, 1, ${new Date(NOW - id * 1000)}, 'x')`;
  }
  const notes = tableOf(await readHubStatus(h.db.sql, NOW), 'Session insight')?.notes.map(text);
  expect(notes).toHaveLength(5);
  expect(notes?.[3]).toBe('2 more failed generations.');
});

test('storage shows the total, the largest tables, and everything else; migrations fold to Details', async () => {
  await using h = await startHub();
  await runningHub(h);
  const status = await readHubStatus(h.db.sql, NOW);
  const storage = tableOf(status, 'Storage');
  expect(storage?.aside).toMatch(/ (MiB|GiB)$/u);
  expect(storage?.rows).toHaveLength(6);
  expect(storage?.rows.at(-1)?.[0]).toEqual(['everything else']);
  expect(status.tables.map((t) => t.title)).toEqual([
    'Systems and Collectors',
    'Session insight',
    'Storage',
  ]);
  expect(status.details.map((t) => t.title)).toEqual([
    'Condition evaluations',
    'Migrations applied',
  ]);
  expect(row(status, 'Database').text).toMatch(/schema \d+, applied /u);
});
