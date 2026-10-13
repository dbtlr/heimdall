import {
  BUNDLED_PRICES,
  migrate,
  report,
  storeReport,
  storeToken,
  syncPrices,
  timeline,
} from '@heimdall/hub/testing';
// Fills a scratch Hub database with four paired Systems, a week of Vitals, agent
// Sessions, and Conditions, so the dashboard has a fleet to show during
// development. It writes through the Hub's own ingest and migration code, so
// the rollups and views are the ones a real Hub keeps. Run it again to reset.
//
//   HEIMDALL_DATABASE_URL=postgres://localhost/heimdall_scratch bun run --cwd packages/dashboard seed
import { SQL } from 'bun';

import { readFleetOverview } from '../src/server/fleet-overview.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SAMPLE_EVERY_MS = 30 * SECOND;
const GIB = 1024 ** 3;

type Profile = {
  // How busy the System is at a time, in percent, before noise.
  cpu: (t: number) => number;
  diskUsedFraction: number;
  memoryTotalBytes: number;
  name: string;
  platform: 'darwin' | 'linux';
  // Spans, as milliseconds before the seed's `now`, with no Vitals.
  sleeps: [from: number, to: number][];
  sleepsFlag: boolean;
};

const hourOfDay = (t: number) => (t % DAY) / HOUR;
const isWorkHour = (t: number) => hourOfDay(t) >= 9 && hourOfDay(t) < 18;

// The two sleeps in the last day, and a night's sleep on each of the six days before.
const laptopSleeps = (): [number, number][] => [
  [20 * HOUR, 14 * HOUR],
  [7 * HOUR, 5.5 * HOUR],
  ...Array.from({ length: 6 }, (_, i): [number, number] => [
    (i + 1) * DAY + 12 * HOUR,
    (i + 1) * DAY + 4 * HOUR,
  ]),
];

const PROFILES: Profile[] = [
  {
    // A nightly backup keeps the CPU busy at 02:00 UTC.
    cpu: (t) => (hourOfDay(t) >= 2 && hourOfDay(t) < 2.5 ? 70 : 12),
    diskUsedFraction: 0.55,
    memoryTotalBytes: 64 * GIB,
    name: 'server-1',
    platform: 'linux',
    sleeps: [],
    sleepsFlag: false,
  },
  {
    cpu: (t) => (isWorkHour(t) ? 38 + 20 * Math.sin(t / (20 * MINUTE)) : 6),
    diskUsedFraction: 0.62,
    memoryTotalBytes: 32 * GIB,
    name: 'workstation-1',
    platform: 'linux',
    sleeps: [],
    sleepsFlag: false,
  },
  {
    cpu: (t) => 14 + 10 * Math.sin(t / (45 * MINUTE)),
    diskUsedFraction: 0.48,
    memoryTotalBytes: 16 * GIB,
    name: 'laptop-1',
    platform: 'darwin',
    sleeps: laptopSleeps(),
    sleepsFlag: true,
  },
  {
    cpu: () => 4,
    diskUsedFraction: 0.94,
    memoryTotalBytes: 4 * GIB,
    name: 'gateway-1',
    platform: 'linux',
    sleeps: [],
    sleepsFlag: false,
  },
];

// A small deterministic generator of numbers from -1 up to 1, so a reseed draws the same fleet.
const noise = (seed: number) => {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 31 - 1;
  };
};

// The sample times of a System over the week up to `now`, less the spans it slept.
const sampleTimes = (profile: Profile, now: number) => {
  const start = Math.ceil((now - 7 * DAY) / SAMPLE_EVERY_MS) * SAMPLE_EVERY_MS;
  const times: number[] = [];
  for (let t = start; t <= now; t += SAMPLE_EVERY_MS) {
    if (!profile.sleeps.some(([from, to]) => t > now - from && t < now - to)) {
      times.push(t);
    }
  }
  return times;
};

// Sends the System's week of Reports, a day of samples each, as its Collector would.
const sendVitals = async (sql: SQL, profile: Profile, now: number) => {
  const random = noise(profile.name.length * 7919);
  const times = sampleTimes(profile, now);
  for (let from = 0; from < times.length; from += DAY / SAMPLE_EVERY_MS) {
    const chunk = times.slice(from, from + DAY / SAMPLE_EVERY_MS);
    const sent = report(profile.name, chunk);
    sent.collector = { ...sent.collector, platform: profile.platform };
    sent.sentAt = chunk.at(-1) ?? now;
    for (const sample of sent.samples) {
      // Noise, and now and then a burst, so a bucket's low and high spread.
      const burst = random() < 0.05 ? 40 * random() : 0;
      const busy = profile.cpu(sample.t) + 5 * random() + burst;
      sample.cpu = { busyPercent: Math.min(100, Math.max(0.5, busy)) };
      sample.memory = {
        totalBytes: profile.memoryTotalBytes,
        usedBytes: Math.round(profile.memoryTotalBytes * (0.45 + 0.1 * random())),
      };
      sample.disks = [
        {
          mount: '/',
          totalBytes: 500 * GIB,
          usedBytes: Math.round(500 * GIB * profile.diskUsedFraction),
        },
      ];
      sample.uptimeSeconds = (sample.t - (now - 7 * DAY)) / SECOND;
    }
    // oxlint-disable-next-line no-await-in-loop -- a week of Reports, in order.
    await storeReport(sql, {
      receivedAt: sent.sentAt,
      report: { ...sent, sleeps: profile.sleepsFlag, timeZone: 'UTC' },
    });
  }
};

// A Claude Code or Codex Session's request times, one every 7 minutes, within a span.
const requestTimes = (fromSeconds: number, toSeconds: number) =>
  Array.from(
    { length: Math.floor((toSeconds - fromSeconds) / 420) + 1 },
    (_, i) => fromSeconds + i * 420,
  );

const SYSTEM = 'workstation-1';
const hours = (n: number) => n * 3600;

// The workstation's Harness processes and Sessions in the last day: some
// Sessions the Hub links to one process, one it cannot tell between two, and
// one no process the Collector saw ran. Times are seconds before `now`.
const seedSessions = async (sql: SQL, now: number) => {
  const { addProcess, addSession } = timeline(now);
  const claude = { harness: 'claude-code', model: 'claude-sonnet-5-5', system: SYSTEM };
  const codex = { harness: 'codex', model: 'gpt-5.1-codex', system: SYSTEM };
  const tokens = { inputTokens: 40_000, outputTokens: 2500 };
  const api = '/home/dev/projects/api';
  const web = '/home/dev/projects/web';
  const infra = '/home/dev/projects/infra';
  const docs = '/home/dev/projects/docs';

  await addProcess(sql, {
    cwd: api,
    end: -hours(7),
    harness: 'claude-code',
    pid: 4101,
    start: -hours(10),
    system: SYSTEM,
  });
  await addSession(sql, {
    ...claude,
    ...tokens,
    firstCwd: api,
    gitBranch: 'feat/fleet-lanes',
    id: 'api-lanes',
    lastCwd: api,
    requests: requestTimes(-hours(9.8), -hours(7.2)),
  });

  await addProcess(sql, {
    cwd: web,
    end: -hours(3.5),
    harness: 'claude-code',
    pid: 4102,
    start: -hours(5),
    system: SYSTEM,
  });
  await addSession(sql, {
    ...claude,
    ...tokens,
    firstCwd: web,
    gitBranch: 'main',
    id: 'web-polish',
    lastCwd: web,
    requests: requestTimes(-hours(4.9), -hours(3.6)),
  });

  await addProcess(sql, {
    cwd: infra,
    end: -hours(4),
    harness: 'codex',
    pid: 4201,
    start: -hours(6),
    system: SYSTEM,
  });
  await addSession(sql, {
    ...codex,
    ...tokens,
    firstCwd: infra,
    gitBranch: 'ops/backups',
    id: 'infra-backups',
    lastCwd: infra,
    requests: requestTimes(-hours(5.9), -hours(4.1)),
  });

  // Two Claude Code processes in one directory at once: the Hub cannot say which ran the Session.
  await addProcess(sql, {
    cwd: docs,
    end: -hours(1),
    harness: 'claude-code',
    pid: 4103,
    start: -hours(2),
    system: SYSTEM,
  });
  await addProcess(sql, {
    cwd: docs,
    end: -hours(1),
    harness: 'claude-code',
    pid: 4104,
    start: -hours(2),
    system: SYSTEM,
  });
  await addSession(sql, {
    ...claude,
    ...tokens,
    firstCwd: docs,
    gitBranch: 'docs/glossary',
    id: 'docs-glossary',
    lastCwd: docs,
    requests: requestTimes(-hours(1.9), -hours(1.1)),
  });

  // A Codex run the Collector never saw a process for.
  await addSession(sql, {
    ...codex,
    ...tokens,
    firstCwd: '/home/dev/scratch',
    gitBranch: 'spike/queue',
    id: 'scratch-spike',
    lastCwd: '/home/dev/scratch',
    requests: requestTimes(-hours(12), -hours(11)),
  });
};

const seedConditions = async (sql: SQL, now: number) => {
  const { addCondition } = timeline(now);
  await addCondition(sql, {
    kind: 'job_failing',
    raisedAt: -hours(3),
    reason: 'nightly-backup failed 3 runs in a row (exit 1)',
    subject: 'nightly-backup',
    system: 'server-1',
  });
  await addCondition(sql, {
    kind: 'drift',
    raisedAt: -hours(26),
    reason: '/etc/app/config.toml differs from what was recorded',
    subject: '/etc/app/config.toml',
    system: 'server-1',
  });
  await addCondition(sql, {
    clearedAt: -hours(8.5),
    kind: 'service_down',
    raisedAt: -hours(9),
    reason: 'dev-db is not running',
    subject: 'dev-db',
    system: SYSTEM,
  });
  await addCondition(sql, {
    kind: 'low_disk',
    raisedAt: -hours(5),
    reason: '/ is 94% full',
    subject: '/',
    system: 'gateway-1',
  });
};

// Every table the seed writes. Truncating `systems` cascades to the rest.
const TABLES = [
  'systems',
  'paired_systems',
  'projected_sessions',
  'projected_subagents',
  'projected_requests',
  'current_parsers',
  'model_prices',
];

// The seed replaces what a scratch database holds, so before it creates or
// empties anything it refuses a database that holds tables but is no Hub's,
// and a Hub's database with a System it did not seed.
const refuseUnlessScratch = async (sql: SQL) => {
  const [schema]: { hub: boolean; tables: number }[] = await sql`
    SELECT count(*)::int AS tables, to_regclass('public.systems') IS NOT NULL AS hub
    FROM pg_tables WHERE schemaname = 'public'
  `;
  const { hub = false, tables = 0 } = schema ?? {};
  if (tables > 0 && !hub) {
    throw new Error('Refusing to seed a database that holds tables but no Hub schema.');
  }
  if (!hub) {
    return;
  }
  const seeded = new Set(PROFILES.map(({ name }) => name));
  const rows: { name: string }[] = await sql`SELECT name FROM systems`;
  const others = rows.map(({ name }) => name).filter((name) => !seeded.has(name));
  if (others.length > 0) {
    throw new Error(`Refusing to reset a database that holds other Systems: ${others.join(', ')}.`);
  }
};

const seed = async (url: URL) => {
  console.warn(
    `This replaces the Heimdall data in database "${url.pathname.slice(1)}" on ${url.host}. Use a scratch database, never a real Hub's.`,
  );
  const sql = new SQL(url.href);
  try {
    await fill(sql);
  } finally {
    await sql.close();
  }
};

const fill = async (sql: SQL) => {
  const now = Date.now();
  await refuseUnlessScratch(sql);
  await migrate(sql);
  await sql.unsafe(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  await syncPrices(sql, { bundled: BUNDLED_PRICES, configured: [] });
  for (const { name } of PROFILES) {
    // oxlint-disable-next-line no-await-in-loop -- four Systems.
    await storeToken(sql, { pairedAt: now - 8 * DAY, system: name, token: `seed-token-${name}` });
  }
  await Promise.all(PROFILES.map((profile) => sendVitals(sql, profile, now)));
  await seedConditions(sql, now);
  await seedSessions(sql, now);
  const overview = await readFleetOverview(sql, { now, range: '24h', timeZone: 'UTC' });
  for (const lane of overview.lanes) {
    console.log(
      `${lane.name}: ${lane.status}, ${lane.buckets.length} buckets, ${lane.gaps.length} gaps, ${lane.stretches.length} stretches, ${lane.conditions.length} Condition marks`,
    );
  }
  console.log(`${overview.open.length} open Conditions.`);
};

const configured = process.env.HEIMDALL_DATABASE_URL;
if (configured === undefined || configured === '') {
  console.error('Set HEIMDALL_DATABASE_URL to a scratch PostgreSQL database for the seed to fill.');
  process.exit(1);
}
await seed(new URL(configured));
