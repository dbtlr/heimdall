import { expect, test } from 'bun:test';

import {
  checkedUpstream as hubChecksUpstream,
  deliverAlerts,
  hubStatusRecorder,
  NOW,
  push,
  recordListening,
  report,
  startHub,
} from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { hubVerdict } from '../components/hub-status.tsx';
import { phraseText } from '../lib/phrase.ts';
import type { Phrase } from '../lib/phrase.ts';
import type { HubStatus } from './hub-status-types.ts';
import { checkedUpstream, readHubStatus, readHubVersion } from './hub-status.ts';

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
  prices: { budget_ms: 90_000, interval_ms: 3_600_000 },
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

test('an older Hub asks for the upgrade alongside any part that needs a look', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await h.db.sql`DROP TABLE hub_status`;
  await raise(h, 'server-1', 'system_stale', 'warning');
  const { summary, verdict } = hubVerdict(await readHubStatus(h.db.sql, NOW));
  expect(verdict).toBe('1 needs a look');
  expect(text(summary)).toBe(
    'Intake needs attention. Upgrade the Hub to record its version, delivery configuration, and timer passes.',
  );
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

test('upstream checks leave out the APT and Homebrew upstreams the Hub never checks', async () => {
  await using h = await startHub();
  await runningHub(h);
  await h.db.sql`INSERT INTO mirrored_records (system, kind, name, record)
    VALUES ('server-1', 'service', 'nginx', '{}'), ('server-1', 'service', 'tool', '{}'),
      ('server-1', 'service', 'jq', '{}')`;
  await h.db.sql`INSERT INTO service_versions (system, service, version, upstream, first_seen_at)
    VALUES ('server-1', 'nginx', '1.0', 'apt:nginx', ${new Date(NOW)}),
      ('server-1', 'jq', '1.7', 'brew:jq', ${new Date(NOW)}),
      ('server-1', 'tool', '1.0', 'github:example/tool', ${new Date(NOW)})`;
  await h.db.sql`INSERT INTO upstream_checks (upstream, checked_at, next_check_at)
    VALUES ('github:example/tool', ${new Date(NOW - 60_000)}, ${new Date(NOW + 3_600_000)})`;
  expect(row(await readHubStatus(h.db.sql, NOW), 'Upstream checks').text).toBe(
    '1 of 1 upstream checked · none failing',
  );
});

test("the dashboard counts the upstreams the Hub checks, by the Hub's own rule", () => {
  for (const upstream of [
    'apt:nginx',
    'brew:jq',
    'github:example/tool',
    'npm:@example/tool',
    'oci:ghcr.io/example/tool',
    'pypi:tool',
    'githubx:example/tool',
  ]) {
    expect(checkedUpstream(upstream)).toBe(hubChecksUpstream(upstream));
  }
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

// A pass's schedule as serve hands it to the recorder.
const schedule = (name: 'delivery' | 'listening') => ({
  budgetMs: SCHEDULES[name].budget_ms,
  intervalMs: SCHEDULES[name].interval_ms,
});

const channelDown = async () => {
  throw new Error('channel unreachable');
};

// A Hub whose status recorder runs its listening and delivery passes on a
// clock the test sets: `passesAt` moves the clock, runs listening and, unless
// told not to, delivery with `deliver`, and reads the Alert delivery row. A
// failed pass is logged by serve and tried again on its next round.
const recordingHub = async (h: Hub, deliver: (now: number) => Promise<void>) => {
  let t = NOW;
  const status = hubStatusRecorder({ now: () => t, sql: h.db.sql, warn: () => undefined });
  await status.start({
    deliveryConfigured: true,
    passes: { delivery: schedule('delivery'), listening: schedule('listening') },
    version: '1.2.3',
  });
  return async (at: number, { delivers = true } = {}) => {
    t = at;
    await status.pass(
      'listening',
      () => h.db.sql`UPDATE hub_listening SET heard_at = ${new Date(at)}`,
    );
    if (delivers) {
      try {
        await status.pass('delivery', () => deliver(at));
      } catch {
        // As serve logs it and runs the pass again on its next round.
      }
    }
    return row(await readHubStatus(h.db.sql, at), 'Alert delivery');
  };
};

test("a failing send waits for Home's 10 minutes, unless the delivery pass falls behind", async () => {
  await using h = await startHub();
  await runningHub(h);
  await raise(h, 'server-1', 'service_down', 'alert', 'nginx');
  const passesAt = await recordingHub(h, (now) =>
    deliverAlerts(h.db.sql, { dashboard: new URL('http://hub.test/'), now, send: channelDown }),
  );
  expect((await passesAt(NOW)).state).toBe('ok');
  expect((await passesAt(NOW + 60_000)).state).toBe('ok');
  expect(await passesAt(NOW + 200_000, { delivers: false })).toMatchObject({
    state: 'warning',
    text: 'Delivery pass overdue: last started 2 min ago',
  });
  expect((await passesAt(NOW + 599_000)).state).toBe('ok');
  expect(await passesAt(NOW + 600_000)).toMatchObject({
    state: 'warning',
    text: 'Failing since 12:00 (10 min) · 1 alert not pushed',
  });
});

test('a delivery pass that fails before it sends waits for the same 10 minutes', async () => {
  await using h = await startHub();
  await runningHub(h);
  const passesAt = await recordingHub(h, channelDown);
  expect((await passesAt(NOW)).state).toBe('ok');
  expect((await passesAt(NOW + 599_000)).state).toBe('ok');
  expect(await passesAt(NOW + 600_000)).toMatchObject({
    state: 'warning',
    text: 'Failing since 12:00 (10 min)',
  });
});

const partsWarning = (status: HubStatus) =>
  status.checks.filter((c) => c.state === 'warning').map((c) => c.part);

test('a Hub that has just stopped reads current until listening is overdue, then says so once', async () => {
  await using h = await startHub();
  await runningHub(h);
  const warnings = async (after: number) => {
    const status = await readHubStatus(h.db.sql, NOW + after);
    return { down: status.down !== undefined, warnings: partsWarning(status) };
  };
  expect(await warnings(65_000)).toEqual({ down: false, warnings: [] });
  expect(await warnings(80_000)).toEqual({ down: false, warnings: [] });
  expect(await warnings(90_000)).toEqual({ down: false, warnings: [] });
  expect(await warnings(91_000)).toEqual({ down: true, warnings: ['Listening'] });
  expect(await warnings(121_000)).toEqual({ down: true, warnings: ['Listening'] });
});

test('a Hub that stopped says once what is known, and no pass it left behind warns on its own', async () => {
  await using h = await startHub();
  await runningHub(h);
  const later = NOW + 3 * 3_600_000;
  const status = await readHubStatus(h.db.sql, later);
  expect(text(status.down)).toBe(
    'The Hub has recorded nothing for 3 h: it may be stopped or stuck.',
  );
  expect(hubVerdict(status).verdict).toBe('Hub silent');
  expect(row(status, 'Listening')).toMatchObject({
    state: 'warning',
    text: 'Nothing recorded since 12:00',
  });
  expect(partsWarning(status)).toEqual(['Listening']);
  expect(row(status, 'Conditions').text).toBe('Condition evaluation last ran 3 h ago');
});

test('an older Hub without the status table is silent after the outage limit, and still asks for the upgrade', async () => {
  await using h = await startHub();
  await recordListening(h.db.sql, NOW);
  await h.db.sql`DROP TABLE hub_status`;
  expect((await readHubStatus(h.db.sql, NOW + 120_000)).down).toBeUndefined();
  const { summary, verdict } = hubVerdict(await readHubStatus(h.db.sql, NOW + 121_000));
  expect(verdict).toBe('Hub silent');
  expect(text(summary)).toBe(
    'The Hub has recorded nothing for 2 min: it may be stopped or stuck. Upgrade the Hub to record its version, delivery configuration, and timer passes.',
  );
});

type PassName = keyof typeof SCHEDULES;
const PASSES = Object.keys(SCHEDULES) as PassName[];

// A Hub run as serve runs it, on a clock the test sets: the real status
// recorder, started with serve's schedules, and the real listening heartbeat
// as the listening pass's task. Its status writes give up on a held lock
// after a short wait, and each logged warning is kept.
const liveHub = async (h: Hub) => {
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  const clock = { t: NOW };
  const warnings: string[] = [];
  const status = hubStatusRecorder({
    lockTimeoutMs: 50,
    now: () => clock.t,
    sql: h.db.sql,
    warn: (message) => warnings.push(message),
  });
  await status.start({
    deliveryConfigured: true,
    passes: Object.fromEntries(
      PASSES.map((name) => [
        name,
        { budgetMs: SCHEDULES[name].budget_ms, intervalMs: SCHEDULES[name].interval_ms },
      ]),
    ),
    version: '1.2.3',
  });
  const task = (name: PassName) =>
    name === 'listening' ? () => recordListening(h.db.sql, clock.t) : async () => undefined;
  return {
    // Runs each named pass to completion at `at`.
    at: async (at: number, names: PassName[] = PASSES) => {
      clock.t = at;
      for (const name of names) {
        // oxlint-disable-next-line no-await-in-loop -- serve's passes write one row.
        await status.pass(name, task(name));
      }
    },
    // Starts each named pass at `at`, records its start, and leaves it hung.
    hangs: async (at: number, names: PassName[]) => {
      clock.t = at;
      for (const name of names) {
        const { promise, resolve } = Promise.withResolvers<void>();
        void status.pass(name, async () => {
          resolve();
          // A promise nothing settles, as a hung run awaits.
          await Promise.withResolvers<void>().promise;
        });
        // oxlint-disable-next-line no-await-in-loop -- one start row write after another.
        await promise;
      }
    },
    // Holds the status row from a second session while `during` runs.
    held: async (during: () => Promise<void>) => {
      const holder = await h.db.sql.reserve();
      try {
        await holder`BEGIN`;
        await holder`SELECT * FROM hub_status FOR UPDATE`;
        await during();
      } finally {
        await holder`ROLLBACK`;
        await holder.release();
      }
    },
    warnings,
  };
};

test('listening status writes a held row timed out leave no outage while the heartbeat and other passes are fresh', async () => {
  await using h = await startHub();
  const hub = await liveHub(h);
  await hub.at(NOW);
  await hub.held(async () => {
    for (const after of [30_000, 60_000, 90_000, 120_000]) {
      // oxlint-disable-next-line no-await-in-loop -- one listening round after another.
      await hub.at(NOW + after, ['listening']);
    }
  });
  expect(hub.warnings.length).toBe(8);
  expect(hub.warnings[0]).toContain('lock timeout');
  await hub.at(NOW + 120_000, ['conditions', 'delivery', 'parse', 'refresh']);
  const status = await readHubStatus(h.db.sql, NOW + 120_000);
  expect(status.down).toBeUndefined();
  expect(partsWarning(status)).toEqual([]);
  expect(row(status, 'Listening')).toMatchObject({ state: 'ok' });
  expect(row(status, 'Listening').text).toEndWith('last recorded 0 s ago');
  expect(hubVerdict(status).verdict).toBe('All well');
});

test('a hung listening pass does not hide other hung passes: silence is a verdict, and continued writes name each', async () => {
  await using h = await startHub();
  const hub = await liveHub(h);
  await hub.at(NOW);
  await hub.hangs(NOW + 1_000, ['listening', 'parse', 'conditions']);
  const hourLater = NOW + 3_600_000;
  const silent = await readHubStatus(h.db.sql, hourLater);
  expect(text(silent.down)).toBe(
    'The Hub has recorded nothing for 59 min: it may be stopped or stuck.',
  );
  expect(hubVerdict(silent).verdict).toBe('Hub silent');

  await hub.at(hourLater, ['delivery', 'refresh', 'upstreams']);
  const writing = await readHubStatus(h.db.sql, hourLater);
  expect(writing.down).toBeUndefined();
  expect(partsWarning(writing)).toEqual(['Listening', 'Session insight', 'Conditions']);
  expect(row(writing, 'Listening').text).toBe(
    'Listening pass running for 59 min, longer than its usual most',
  );
  expect(row(writing, 'Session insight').detail).toContain(
    'Parse pass running for 59 min, longer than its usual most',
  );
  expect(row(writing, 'Conditions').text).toBe(
    'Condition evaluation running for 59 min, longer than its usual most',
  );
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
  await h.db.sql`UPDATE hub_status SET last_runs = jsonb_set(last_runs, '{listening}',
    last_runs->'listening' || ${h.db.sql.json({ finished_at: NOW + 100_000, started_at: NOW + 99_900 })}::jsonb)`;
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

// Two bundled models, one of them configured too, and fetched entries for
// that one and a third: three models priced, one configured, two fetched.
const pricedModels = async (h: Hub) => {
  await h.db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('model-a', '2026-01-01', 'bundled', 1, 1, 1000),
           ('model-b', '2026-01-01', 'bundled', 1, 1, 1000),
           ('model-b', '2026-01-01', 'configured', 2, 2, 1000)`;
  await h.db.sql`
    INSERT INTO fetched_model_prices (model, valid_from, input_per_mtok, output_per_mtok, context_window)
    VALUES ('model-b', '2026-01-01', 3, 3, 1000), ('model-c', '2026-01-01', 3, 3, 1000)`;
};

test('the price table counts the models across both tables, the configured ones, and the fetched ones', async () => {
  await using h = await startHub();
  await runningHub(h);
  await pricedModels(h);
  const prices = row(await readHubStatus(h.db.sql, NOW + 12_000), 'Price table');
  expect(prices).toEqual({
    detail: 'Price fetch ran 12 s ago · Every stored request has a price',
    state: 'ok',
    text: '3 models, 1 configured, 2 fetched',
  });
});

// The price table row of a running Hub whose prices pass recorded `prices`,
// read at `at`, when the Hub was last heard.
const priceTableWith = async (prices: object, at = NOW) => {
  await using h = await startHub();
  await runningHub(h, { runs: { prices } });
  await h.db.sql`UPDATE hub_listening SET heard_at = ${new Date(at)}`;
  return row(await readHubStatus(h.db.sql, at), 'Price table');
};

test('the price table warns while the prices pass is failing, overdue, or running too long', async () => {
  expect(
    await priceTableWith({ failing_since: NOW - 60_000, succeeded_at: NOW - 3_600_000 }),
  ).toMatchObject({
    detail: expect.stringContaining('Price fetch failing since 11:59'),
    state: 'warning',
  });
  const later = NOW + 3 * 3_600_000;
  expect(await priceTableWith({}, later)).toMatchObject({
    detail: expect.stringContaining('Price fetch overdue: last started 3 h ago'),
    state: 'warning',
  });
  expect(
    await priceTableWith({
      finished_at: NOW - 3 * 3_600_000,
      started_at: NOW - 2 * 3_600_000 - 100_000,
    }),
  ).toMatchObject({
    detail: expect.stringContaining('longer than its usual most'),
    state: 'warning',
  });
});

test('the price table says fetching is off when the prices pass records it, and unknown without one', async () => {
  await using h = await startHub();
  await runningHub(h, {
    runs: {
      prices: { finished_at: undefined, off: true, started_at: undefined, succeeded_at: undefined },
    },
  });
  expect(row(await readHubStatus(h.db.sql, NOW), 'Price table')).toMatchObject({
    detail: 'Fetching off · Every stored request has a price',
    state: 'ok',
  });
  await h.db.sql`UPDATE hub_status SET last_runs = last_runs - 'prices'`;
  expect(row(await readHubStatus(h.db.sql, NOW), 'Price table')).toMatchObject({
    detail: 'Price fetch unknown · Every stored request has a price',
    state: 'unknown',
  });
});

test('the price table of a Hub older than the fetched prices counts only its own table', async () => {
  await using h = await startHub();
  await runningHub(h);
  await pricedModels(h);
  // Out of the way without dropping the views that read it.
  await h.db.sql`ALTER TABLE fetched_model_prices RENAME TO fetched_model_prices_later`;
  expect(row(await readHubStatus(h.db.sql, NOW), 'Price table').text).toBe(
    '2 models, 1 configured, 0 fetched',
  );
});
