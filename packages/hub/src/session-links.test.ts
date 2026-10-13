import { beforeAll, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { MIGRATIONS, migrate } from './migrations.ts';
import { startTestServer, testDatabase } from './testing/postgres.ts';
import { CWD, timeline } from './testing/timeline.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

// Times are seconds after T0, so a fixture reads as a timeline.
const T0 = Date.parse('2026-10-01T12:00:00Z');
const { addProcess, addSession, addVitals, at } = timeline(T0);

type Db = { sql: SQL } & AsyncDisposable;

// A migrated database with two Systems.
const database = async (): Promise<Db> => {
  const db = await testDatabase();
  await migrate(db.sql);
  await db.sql`
    INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now()), ('server-1', now())
  `;
  return db;
};

// Each stretch as one line: Session, its first and last request in seconds,
// its link, the linked process's pid or '-', and how many processes may have
// run it.
const stretches = async (sql: SQL): Promise<string[]> => {
  const rows: {
    candidates: number;
    ended: number;
    link: string;
    pid: number | null;
    session_id: string;
    started: number;
  }[] = await sql`
    SELECT session_id, link, pid, candidates::integer,
           extract(epoch FROM started_at - ${at(0)}::timestamptz)::float8 AS started,
           extract(epoch FROM ended_at - ${at(0)}::timestamptz)::float8 AS ended
    FROM insight.session_stretches ORDER BY system, session_id, started_at
  `;
  return rows.map(
    (row) =>
      `${row.session_id} ${String(row.started)}-${String(row.ended)} ${row.link} ${row.pid === null ? '-' : String(row.pid)} ${String(row.candidates)}`,
  );
};

test('a Session links to the one process that ran it', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 600, pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [3, 200, 590] });

  expect(await stretches(db.sql)).toEqual(['s1 3-590 linked 100 1']);
});

test('a process that ran two Sessions in turn links both', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [5, 400] });
  await addSession(db.sql, { id: 's2', requests: [420, 900] });

  expect(await stretches(db.sql)).toEqual(['s1 5-400 linked 100 1', 's2 420-900 linked 100 1']);
});

test('a Session resumed in a new process links each stretch to the process that ran it then', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 300, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 2000, pid: 200, start: 1000 });
  await addSession(db.sql, { id: 's1', requests: [10, 100, 290, 1010, 1500] });

  expect(await stretches(db.sql)).toEqual(['s1 10-290 linked 100 1', 's1 1010-1500 linked 200 1']);
  const requests = await db.sql`
    SELECT request_id, pid FROM insight.request_links ORDER BY at
  `;
  expect(requests).toEqual([
    { pid: 100, request_id: 's1-0' },
    { pid: 100, request_id: 's1-1' },
    { pid: 100, request_id: 's1-2' },
    { pid: 200, request_id: 's1-3' },
    { pid: 200, request_id: 's1-4' },
  ]);
});

test('two concurrent Sessions in one directory under two processes of the same Harness stay unlinked', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 1001, pid: 200, start: 1 });
  await addSession(db.sql, { id: 's1', requests: [20, 500] });
  await addSession(db.sql, { id: 's2', requests: [30, 600] });

  expect(await stretches(db.sql)).toEqual(['s1 20-500 ambiguous - 2', 's2 30-600 ambiguous - 2']);
});

test('a second process splits a Session into the stretch it could not have run and the stretch it could', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 2000, pid: 200, start: 500 });
  await addSession(db.sql, { id: 's1', requests: [20, 400, 600, 900] });

  expect(await stretches(db.sql)).toEqual(['s1 20-400 linked 100 1', 's1 600-900 ambiguous - 2']);
});

test('a process that ran before or after a Session never links to it', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 100, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 900, pid: 200, start: 500 });
  await addSession(db.sql, { id: 's1', requests: [200, 400] });

  expect(await stretches(db.sql)).toEqual(['s1 200-400 unmatched - 0']);
});

test('a process on another System, of another Harness, or in another directory never links', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0, system: 'server-1' });
  await addProcess(db.sql, { end: 1000, harness: 'codex', pid: 200, start: 0 });
  await addProcess(db.sql, { cwd: '/home/someone/work/other', end: 1000, pid: 300, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [20, 500] });

  expect(await stretches(db.sql)).toEqual(['s1 20-500 unmatched - 0']);
});

test('a Session links by the directory it ended in as well as the one it started in', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: `${CWD}/sub`, end: 1000, pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', lastCwd: `${CWD}/sub`, requests: [20, 500] });

  expect(await stretches(db.sql)).toEqual(['s1 20-500 linked 100 1']);
});

test('a Session that moved between two directories, each with a process, stays ambiguous', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: '/srv/a', end: 1000, pid: 100, start: 0 });
  await addProcess(db.sql, { cwd: '/srv/b', end: 1000, pid: 200, start: 0 });
  await addSession(db.sql, {
    firstCwd: '/srv/a',
    id: 's1',
    lastCwd: '/srv/b',
    requests: [20, 500],
  });

  expect(await stretches(db.sql)).toEqual(['s1 20-500 ambiguous - 2']);
});

test('a process whose directory is unknown could have run any Session of its Harness', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  await addProcess(db.sql, { cwd: null, end: 1000, pid: 200, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [20, 500] });

  expect(await stretches(db.sql)).toEqual(['s1 20-500 ambiguous - 2']);
});

// A start is to the second and can read up to two seconds early or one late,
// on the same clock as the transcript; the Hub's own clock is never compared.
test('a process whose directory is unknown never links, even alone', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: null, end: 1000, pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [20, 500] });

  expect(await stretches(db.sql)).toEqual(['s1 20-500 unmatched - 1']);
});

test('a stretch ends where a process’s window closes, and the next one begins after it', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 300, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 1000, pid: 200, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [10, 400, 500] });

  expect(await stretches(db.sql)).toEqual(['s1 10-10 ambiguous - 2', 's1 400-500 linked 200 1']);
});

test('a request may come up to 2 seconds before its process start reads, and no more', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 100 });
  await addSession(db.sql, { id: 'at-edge', requests: [98, 500] });
  await addSession(db.sql, { id: 'past-edge', requests: [97.999, 500] });

  expect(await stretches(db.sql)).toEqual([
    'at-edge 98-500 linked 100 1',
    'past-edge 97.999-97.999 unmatched - 0',
    'past-edge 500-500 unmatched - 1',
  ]);
});

test('a process started within 2 seconds after a request could have made it', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 110, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 1000, pid: 200, start: 102 });
  await addSession(db.sql, { id: 'before', requests: [10, 99.999] });
  await addSession(db.sql, { id: 'within', requests: [10, 100] });

  expect(await stretches(db.sql)).toEqual([
    'before 10-99.999 linked 100 1',
    'within 10-10 unmatched - 1',
    'within 100-100 ambiguous - 2',
  ]);
});

test('a stretch with no reading of its process inside it stays unlinked, since an unseen process could have run it', async () => {
  await using db = await database();
  // Readings at 90 and 105; a `claude -p` the Collector never saw ran 91-104.
  await addProcess(db.sql, { pid: 100, start: 0 });
  await addSession(db.sql, { id: 'between-readings', requests: [92, 103] });
  await addSession(db.sql, { id: 'across-a-reading', requests: [92, 106] });

  expect(await stretches(db.sql)).toEqual([
    'across-a-reading 92-106 linked 100 1',
    'between-readings 92-103 unmatched - 1',
  ]);
});

// No rule can see a process the Collector never read. Here a `claude -p` the
// Collector never saw started the Session between readings at 90 and 105,
// and the interactive process, seen throughout, resumed it at 200: nothing
// tells the two apart, so the whole stretch links to the seen process.
test('a Session an unseen process started between two readings links to the seen process that resumed it', async () => {
  await using db = await database();
  await addProcess(db.sql, { pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [92, 103, 200, 300] });

  expect(await stretches(db.sql)).toEqual(['s1 92-300 linked 100 1']);
});

test('a stretch before a process was first seen stays unlinked', async () => {
  await using db = await database();
  // Started at 0, but the Collector came up at 1000.
  await addProcess(db.sql, { pid: 100, seenFrom: 1000, start: 0 });
  await addSession(db.sql, { id: 'before-sighting', requests: [110, 390] });
  await addSession(db.sql, { id: 'after-sighting', requests: [1010, 1390] });

  expect(await stretches(db.sql)).toEqual([
    'after-sighting 1010-1390 linked 100 1',
    'before-sighting 110-390 unmatched - 1',
  ]);
});

test('a process the Hub holds as running ran only until 60 seconds after its last sighting', async () => {
  await using db = await database();
  // Reports stopped after a sighting at 100.
  await addProcess(db.sql, { pid: 100, seenTo: 100, start: 0 });
  await addSession(db.sql, { id: 'at-edge', requests: [50, 160] });
  await addSession(db.sql, { id: 'past-edge', requests: [50, 160.001] });

  expect(await stretches(db.sql)).toEqual([
    'at-edge 50-160 linked 100 1',
    'past-edge 50-160.001 unmatched - 1',
  ]);
});

test('a stretch past a missed end stays unlinked even with no other process', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 100, endMissed: true, pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [50, 200] });

  expect(await stretches(db.sql)).toEqual(['s1 50-200 unmatched - 1']);
});

// A missed end is the last sighting; the process may have run on until the
// Collector looked again, which the System's next Vitals bound.
test('a process whose end was missed may have run until the next Vitals bucket after its last sighting', async () => {
  await using db = await database();
  // Last seen at 100 s; the Collector was back in the bucket from 600 s.
  await addProcess(db.sql, { end: 100, endMissed: true, pid: 100, start: 0 });
  await addVitals(db.sql, 'laptop-1', 90);
  await addVitals(db.sql, 'laptop-1', 700);
  await addProcess(db.sql, { pid: 200, start: 150 });
  await addSession(db.sql, { id: 'seen', requests: [10, 90] });
  await addSession(db.sql, { id: 'during-outage', requests: [620, 680] });
  await addSession(db.sql, { id: 'after-return', requests: [950, 1000] });

  expect(await stretches(db.sql)).toEqual([
    'after-return 950-1000 linked 200 1',
    'during-outage 620-680 ambiguous - 2',
    'seen 10-90 linked 100 1',
  ]);
});

test('a process whose end was missed may have run no later than the end of the next Vitals bucket', async () => {
  await using db = await database();
  // Last seen at 100 s; the Collector was back in the bucket from 300 s, so
  // 100 may have run until 600 s.
  await addProcess(db.sql, { end: 100, endMissed: true, pid: 100, start: 0 });
  await addVitals(db.sql, 'laptop-1', 90);
  await addVitals(db.sql, 'laptop-1', 310);
  await addProcess(db.sql, { pid: 200, start: 150 });
  await addSession(db.sql, { id: 's1', requests: [599, 601, 1000, 1100] });

  expect(await stretches(db.sql)).toEqual(['s1 599-599 ambiguous - 2', 's1 601-1100 linked 200 1']);
});

test('a request past a missed end, with no Vitals since, could still be the missed process’s', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 100, endMissed: true, pid: 100, start: 0 });
  await addProcess(db.sql, { pid: 200, start: 150 });
  await addSession(db.sql, { id: 's1', requests: [8000, 9000] });

  expect(await stretches(db.sql)).toEqual(['s1 8000-9000 ambiguous - 2']);
});

test('a process whose end was missed could have made a request up to 2 seconds before its start reads', async () => {
  await using db = await database();
  await addProcess(db.sql, { pid: 100, start: 0 });
  await addProcess(db.sql, { end: 200, endMissed: true, pid: 200, start: 100 });
  await addSession(db.sql, { id: 's1', requests: [98.5, 99.5] });

  expect(await stretches(db.sql)).toEqual(['s1 98.5-99.5 ambiguous - 2']);
});

test('after its samples are pruned, a stretch stays linked through a whole 5-minute rollup or the last sighting inside it', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1500, pid: 100, rollupsOnly: true, start: 0 });
  // Buckets start every 300 s from T0.
  await addSession(db.sql, { id: 'whole-bucket', requests: [290, 610] });
  await addSession(db.sql, { id: 'part-bucket', requests: [310, 590] });
  await addSession(db.sql, { id: 'last-sighting', requests: [1490, 1500] });
  await addSession(db.sql, { id: 'bucket-start', requests: [590, 650] });

  expect(await stretches(db.sql)).toEqual([
    'bucket-start 590-650 unmatched - 1',
    'last-sighting 1490-1500 linked 100 1',
    'part-bucket 310-590 unmatched - 1',
    'whole-bucket 290-610 linked 100 1',
  ]);
});

test('a stretch counts its own requests', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 2000, pid: 200, start: 500 });
  await addSession(db.sql, { id: 's1', requests: [10, 20, 30, 600, 900] });

  const rows = await db.sql`
    SELECT requests::integer FROM insight.session_stretches ORDER BY started_at
  `;
  expect(rows).toEqual([{ requests: 3 }, { requests: 2 }]);
});

const setReading = async (
  sql: SQL,
  process: number,
  t: number,
  cpuSeconds: number,
  rssBytes: number,
) => {
  await sql`
    INSERT INTO harness_process_samples (process, t, cpu_micros, rss_bytes)
    VALUES (${process}, ${at(t)}, ${cpuSeconds * 1_000_000}, ${rssBytes})
    ON CONFLICT (process, t) DO UPDATE SET cpu_micros = excluded.cpu_micros,
      rss_bytes = excluded.rss_bytes
  `;
};

test('a Vitals sample shows each process running then once, with the reading its interval holds', async () => {
  await using db = await database();
  const busy = await addProcess(db.sql, { pid: 100, seenTo: 1000, start: 0 });
  await setReading(db.sql, busy, 985, 100, 4000);
  await setReading(db.sql, busy, 1000, 115, 6000);
  await setReading(db.sql, busy, 1015, 145, 8000);
  // Its only reading is before the sample's interval.
  await addProcess(db.sql, { cwd: '/srv/quiet', pid: 200, seenFrom: 995, seenTo: 995, start: 0 });
  // Its reading is at the interval's start, which the sample before covers.
  await addProcess(db.sql, { cwd: '/srv/edge', pid: 300, seenFrom: 1003, seenTo: 1003, start: 0 });
  await addProcess(db.sql, { cwd: '/srv/gone', end: 900, pid: 400, start: 0 });
  await addProcess(db.sql, { cwd: '/srv/later', pid: 500, start: 1100 });
  await addProcess(db.sql, { cwd: '/srv/missed', end: 950, endMissed: true, pid: 600, start: 0 });
  // Two Sessions in one process at once, as after /resume within it.
  await addSession(db.sql, { id: 'first', requests: [900, 1010, 1020] });
  await addSession(db.sql, { id: 'second', requests: [1005, 1012, 1030] });
  await addVitals(db.sql, 'laptop-1', 1003);
  await addVitals(db.sql, 'laptop-1', 1015, 90);

  const rows = await db.sql`
    SELECT pid, read_at, cpu_cores, rss_bytes
    FROM insight.vitals_processes WHERE system = 'laptop-1' AND t = ${at(1015)}
    ORDER BY pid
  `;
  expect(rows).toEqual([
    { cpu_cores: 2, pid: 100, read_at: at(1015), rss_bytes: '8000' },
    { cpu_cores: null, pid: 200, read_at: null, rss_bytes: null },
    { cpu_cores: null, pid: 300, read_at: null, rss_bytes: null },
  ]);
  const sessions = await db.sql`
    SELECT pid, session_id FROM insight.vitals_sessions
    WHERE system = 'laptop-1' AND t = ${at(1015)} ORDER BY session_id
  `;
  expect(sessions).toEqual([
    { pid: 100, session_id: 'first' },
    { pid: 100, session_id: 'second' },
  ]);
  const [vitals] = await db.sql`
    SELECT cpu_busy_percent FROM insight.vitals WHERE system = 'laptop-1' AND t = ${at(1015)}
  `;
  expect(vitals).toEqual({ cpu_busy_percent: 90 });
});

test('each request lands in the one Vitals sample whose interval holds it, with the process its stretch links to', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 300, pid: 100, start: 0 });
  await addProcess(db.sql, { end: 2000, pid: 200, start: 1000 });
  await addSession(db.sql, { id: 'resumed', requests: [10, 30, 290, 1010, 1031, 1500] });
  // The oldest sample covers the 15 seconds before it.
  await addSession(db.sql, { id: 'early', requests: [-20, -10] });
  await addVitals(db.sql, 'laptop-1', 0);
  await addVitals(db.sql, 'laptop-1', 31);
  await addVitals(db.sql, 'laptop-1', 1000);
  await addVitals(db.sql, 'laptop-1', 1031);

  const rows: { request_id: string; pid: number | null; t: Date }[] = await db.sql`
    SELECT t, request_id, pid FROM insight.vitals_requests
    WHERE system = 'laptop-1' ORDER BY t, request_id
  `;
  expect(rows).toEqual([
    { pid: null, request_id: 'early-1', t: at(0) },
    { pid: 100, request_id: 'resumed-0', t: at(31) },
    { pid: 100, request_id: 'resumed-1', t: at(31) },
    { pid: 100, request_id: 'resumed-2', t: at(1000) },
    { pid: 200, request_id: 'resumed-3', t: at(1031) },
    { pid: 200, request_id: 'resumed-4', t: at(1031) },
  ]);
});

test('a Vitals sample shows a Session under a process only while a stretch linked to that process holds the sample', async () => {
  await using db = await database();
  await addProcess(db.sql, { pid: 100, start: 0 });
  await addProcess(db.sql, { pid: 200, start: 1013 });
  // Linked to 100 for 900-1010; from 1020 both processes may have run it.
  await addSession(db.sql, { id: 's1', requests: [900, 1010, 1020, 1040] });
  await addVitals(db.sql, 'laptop-1', 1005);
  await addVitals(db.sql, 'laptop-1', 1015);
  await addVitals(db.sql, 'laptop-1', 1030);

  const rows = await db.sql`
    SELECT t, pid, session_id FROM insight.vitals_sessions ORDER BY t, pid
  `;
  expect(rows).toEqual([{ pid: 100, session_id: 's1', t: at(1005) }]);
});

test('a Vitals sample shows a Session while a linked stretch holds it, though only its subagent made requests then', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  // The main transcript ends at 100; its subagent goes on from 150 to 250.
  await addSession(db.sql, { id: 's1', requests: [5, 100], subagentRequests: [150, 250] });
  for (const t of [90, 105, 200, 240, 260]) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture rows.
    await addVitals(db.sql, 'laptop-1', t);
  }

  expect(await stretches(db.sql)).toEqual(['s1 5-250 linked 100 1']);
  const rows = await db.sql`
    SELECT t, pid, session_id FROM insight.vitals_sessions ORDER BY t
  `;
  expect(rows).toEqual([
    { pid: 100, session_id: 's1', t: at(90) },
    { pid: 100, session_id: 's1', t: at(105) },
    { pid: 100, session_id: 's1', t: at(200) },
    { pid: 100, session_id: 's1', t: at(240) },
  ]);
});

test('a Session stored before its request span was kept shows in the Vitals once migrated', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 17),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [5, 100], subagentRequests: [150, 250] });
  await addVitals(db.sql, 'laptop-1', 200);

  await migrate(db.sql);

  const rows = await db.sql`SELECT t, pid, session_id FROM insight.vitals_sessions`;
  expect(rows).toEqual([{ pid: 100, session_id: 's1', t: at(200) }]);
});

test('a request stored again at a later time widens its Session’s request span', async () => {
  await using db = await database();
  await addProcess(db.sql, { end: 1000, pid: 100, start: 0 });
  await addSession(db.sql, { id: 's1', requests: [5, 100] });
  await addVitals(db.sql, 'laptop-1', 200);
  await db.sql`
    INSERT INTO projected_requests (
      harness, parser_version, system, source, session_id, request_id, at, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, generation, byte_offset
    )
    SELECT harness, parser_version, system, source, session_id, request_id, ${at(250)}, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, generation, byte_offset
    FROM projected_requests WHERE request_id = 's1-1'
    ON CONFLICT (harness, parser_version, system, source, request_id) DO UPDATE SET at = excluded.at
  `;

  const rows = await db.sql`SELECT t, pid, session_id FROM insight.vitals_sessions`;
  expect(rows).toEqual([{ pid: 100, session_id: 's1', t: at(200) }]);
});
