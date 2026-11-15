import { expect, test } from 'bun:test';

import { NOW, push, report, startHub } from '@heimdall/hub/testing';

import { readHubStatus } from './hub-status.ts';

test('an older Hub has unknown runtime fields, even before the migration', async () => {
  await using h = await startHub();
  expect((await readHubStatus(h.db.sql, NOW)).version).toBe('unknown');
  await h.db.sql`DROP TABLE hub_status`;
  expect((await readHubStatus(h.db.sql, NOW)).version).toBe('unknown');
});

test('current DB rows produce the all-well checklist; failing delivery and overdue passes explain what is stuck', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  await h.db.sql`INSERT INTO hub_status (version, started_at, delivery_configured, last_runs)
    VALUES ('1.2.3', ${new Date(NOW)}, true, ${h.db.sql.json({ conditions: NOW, delivery: NOW, listening: NOW, parse: NOW, prune: NOW, refresh: NOW, upstreams: NOW })})`;
  await h.db
    .sql`UPDATE hub_listening SET heard_at = ${new Date(NOW)}, listening_since = ${new Date(NOW)}`;
  expect((await readHubStatus(h.db.sql, NOW)).checks.every((r) => r.state === 'ok')).toBe(true);
  await h.db.sql`UPDATE delivery_status SET failing_since = ${new Date(NOW - 1000)}`;
  const stuck = await readHubStatus(h.db.sql, NOW + 8_000_000);
  expect(stuck.checks.find((r) => r.part === 'Alert delivery')?.text).toContain('Failing since');
  expect(stuck.checks.find((r) => r.part === 'Intake')?.text).toContain('not reporting');
  expect(stuck.checks.find((r) => r.part === 'Conditions')?.text).toContain('overdue');
  expect(stuck.checks.find((r) => r.part === 'Retention')?.text).toContain('overdue');
});

test('parser failures, rebuilds and refresh retries are counts, never failure text', async () => {
  await using h = await startHub();
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
  const result = await readHubStatus(h.db.sql, NOW);
  expect(result.checks.find((r) => r.part === 'Session insight')?.text).toContain(
    '1 generation failed',
  );
  expect(result.checks.find((r) => r.part === 'Stored Session totals')?.text).toContain(
    '1 refresh retry',
  );
  expect(JSON.stringify(result)).toContain('Rebuilding to v2');
  expect(JSON.stringify(result)).not.toContain('SECRET TRANSCRIPT CONTENT');
});

test('a stalled rebuild and each overdue timer are visible, with refresh backlog counts', async () => {
  await using h = await startHub();
  await h.db
    .sql`INSERT INTO hub_status (version, started_at, delivery_configured) VALUES ('test', ${new Date(NOW - 10_000_000)}, true)`;
  await h.db.sql`INSERT INTO current_parsers VALUES ('codex', 1)`;
  await h.db
    .sql`INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
    VALUES (1, 'server-1', 'codex', 'session.jsonl', ${new Date(NOW)}, ${new Date(NOW)})`;
  await h.db
    .sql`INSERT INTO parse_progress (harness, parser_version, generation, parsed_through, held_seen) VALUES ('codex', 2, 1, 0, 0)`;
  const status = await readHubStatus(h.db.sql, NOW);
  for (const part of [
    'Listening',
    'Session insight',
    'Stored Session totals',
    'Conditions',
    'Alert delivery',
    'Upstream checks',
    'Retention',
  ]) {
    expect(status.checks.find((c) => c.part === part)?.state).not.toBe('ok');
  }
  expect(status.checks.find((c) => c.part === 'Session insight')?.detail).toContain(
    'rebuild stalled',
  );
});

test('sleeping Systems use seven days, and upstream failures name the stuck part', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, { ...report('laptop-1', [NOW]), sleeps: true }, { token: 'laptop-token' });
  await h.db
    .sql`UPDATE systems SET last_seen_at = ${new Date(NOW - 86_400_000)} WHERE name = 'laptop-1'`;
  expect((await readHubStatus(h.db.sql, NOW)).checks.find((c) => c.part === 'Intake')?.state).toBe(
    'ok',
  );
  await h.db.sql`INSERT INTO upstream_checks (upstream, checked_at, next_check_at, failure)
    VALUES ('github:example/tool', ${new Date(NOW)}, ${new Date(NOW + 60_000)}, 'HTTP 503')`;
  const failed = await readHubStatus(h.db.sql, NOW + 8 * 86_400_000);
  expect(failed.checks.find((c) => c.part === 'Intake')?.text).toContain('2 not reporting');
  expect(failed.checks.find((c) => c.part === 'Upstream checks')?.text).toContain('1 failing');
});
