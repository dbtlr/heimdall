import { createHash } from 'node:crypto';

import {
  BUNDLED_PRICES,
  migrate,
  refreshSessionInsight,
  report,
  storeReport,
  storeToken,
  syncPrices,
  timeline,
  unpair,
} from '@heimdall/hub/testing';
import type { RequestFixture, SubagentFixture, ToolCallFixture } from '@heimdall/hub/testing';
// Fills a scratch Hub database with four paired Systems and one unpaired, a week
// of Vitals, agent Sessions, the records, runs, checks, and Harness installs a
// provisioner and Collector would report for some of them, and Conditions, so
// the dashboard has a fleet to show during development. It writes through the Hub's own ingest and migration code, so
// the rollups and views are the ones a real Hub keeps. Run it again to reset.
//
//   HEIMDALL_DATABASE_URL=postgres://localhost/heimdall_scratch bun run --cwd packages/dashboard seed
import { filesRecordDigest } from '@heimdall/schema';
import { SQL } from 'bun';

import { readFleetOverview } from '../src/server/fleet-overview.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SAMPLE_EVERY_MS = 30 * SECOND;
const GIB = 1024 ** 3;

// The seeded System that is unpaired after it reports, with its history kept.
const UNPAIRED_SYSTEM = 'build-2';

type Profile = {
  // How busy the System is at a time, in percent, before noise.
  cpu: (t: number) => number;
  disks: { mount: string; totalGib: number; usedFraction: number }[];
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
    disks: [{ mount: '/', totalGib: 500, usedFraction: 0.55 }],
    memoryTotalBytes: 64 * GIB,
    name: 'server-1',
    platform: 'linux',
    sleeps: [],
    sleepsFlag: false,
  },
  {
    cpu: (t) => (isWorkHour(t) ? 38 + 20 * Math.sin(t / (20 * MINUTE)) : 6),
    // `/backup` is nearly full, so the facts card shows a mount in orange.
    disks: [
      { mount: '/', totalGib: 500, usedFraction: 0.62 },
      { mount: '/data', totalGib: 3600, usedFraction: 0.58 },
      { mount: '/backup', totalGib: 4000, usedFraction: 0.97 },
    ],
    memoryTotalBytes: 32 * GIB,
    name: 'workstation-1',
    platform: 'linux',
    sleeps: [],
    sleepsFlag: false,
  },
  {
    cpu: (t) => 14 + 10 * Math.sin(t / (45 * MINUTE)),
    disks: [{ mount: '/', totalGib: 500, usedFraction: 0.48 }],
    memoryTotalBytes: 16 * GIB,
    name: 'laptop-1',
    platform: 'darwin',
    sleeps: laptopSleeps(),
    sleepsFlag: true,
  },
  {
    cpu: () => 4,
    disks: [{ mount: '/', totalGib: 500, usedFraction: 0.94 }],
    memoryTotalBytes: 4 * GIB,
    name: 'gateway-1',
    platform: 'linux',
    sleeps: [],
    sleepsFlag: false,
  },
  {
    cpu: (t) => 18 + 6 * Math.sin(t / (30 * MINUTE)),
    disks: [{ mount: '/', totalGib: 250, usedFraction: 0.52 }],
    memoryTotalBytes: 8 * GIB,
    name: UNPAIRED_SYSTEM,
    platform: 'linux',
    // Sends nothing for the last 9 hours: the seed unpairs it.
    sleeps: [[9 * HOUR, 0]],
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

// Reports sent this long before now or more carry the `earlier` sections.
const EARLIER_AGO_MS = 6 * HOUR;
// A System's sample times as the day-long batches of one Report each.
const days = (all: number[]) =>
  Array.from({ length: Math.ceil(all.length / (DAY / SAMPLE_EVERY_MS)) }, (_, i) =>
    all.slice(i * (DAY / SAMPLE_EVERY_MS), (i + 1) * (DAY / SAMPLE_EVERY_MS)),
  );

// The Reports of a System's week as batches of samples, a day each, with the
// sections each carries: `earlier` rides the last Report sent `EARLIER_AGO_MS`
// or more before now, so the Hub holds checks or runs that stopped arriving;
// `provisioned` rides the last Report.
const batchesOf = (
  times: number[],
  now: number,
  {
    earlier,
    provisioned,
  }: { earlier: Provisioned | undefined; provisioned: Provisioned | undefined },
) => {
  const split =
    earlier === undefined ? times.length : times.findIndex((t) => t > now - EARLIER_AGO_MS);
  const before = days(times.slice(0, split));
  const after = times.slice(split);
  const sections = (chunks: number[][], last: Provisioned | undefined) =>
    chunks.map((chunk, i) => ({ chunk, sections: i === chunks.length - 1 ? last : undefined }));
  return earlier === undefined
    ? sections(before, provisioned)
    : [...sections(before, earlier), ...sections([after], provisioned)];
};

// Sends the System's week of Reports, a day of samples each, as its Collector would.
// The last Report carries `provisioned`, the sections a Collector sends beside its
// Vitals; `earlier` is the sections of one sent hours before, which later Reports
// do not repeat.
const sendVitals = async (
  sql: SQL,
  profile: Profile,
  now: number,
  sent: { earlier: Provisioned | undefined; provisioned: Provisioned | undefined },
) => {
  const random = noise(profile.name.length * 7919);
  const times = sampleTimes(profile, now);
  for (const { chunk, sections } of batchesOf(times, now, sent)) {
    const body = report(profile.name, chunk);
    body.collector = { ...body.collector, platform: profile.platform };
    body.sentAt = chunk.at(-1) ?? now;
    for (const sample of body.samples) {
      // Noise, and now and then a burst, so a bucket's low and high spread.
      const burst = random() < 0.05 ? 40 * random() : 0;
      const busy = profile.cpu(sample.t) + 5 * random() + burst;
      sample.cpu = { busyPercent: Math.min(100, Math.max(0.5, busy)) };
      sample.memory = {
        totalBytes: profile.memoryTotalBytes,
        usedBytes: Math.round(profile.memoryTotalBytes * (0.45 + 0.1 * random())),
      };
      sample.disks = profile.disks.map(({ mount, totalGib, usedFraction }) => ({
        mount,
        totalBytes: totalGib * GIB,
        usedBytes: Math.round(totalGib * GIB * usedFraction),
      }));
      sample.uptimeSeconds = (sample.t - (now - 7 * DAY)) / SECOND;
    }
    // oxlint-disable-next-line no-await-in-loop -- a week of Reports, in order.
    await storeReport(sql, {
      receivedAt: body.sentAt,
      report: {
        ...body,
        ...sections,
        sleeps: profile.sleepsFlag,
        timeZone: 'UTC',
      },
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

type Report = ReturnType<typeof report>;

// The sections a Collector sends beside Vitals: what its provisioner recorded,
// the runs of its jobs, what it observed against both, and the Harnesses installed.
type Provisioned = Pick<Report, 'checks' | 'harnesses' | 'records' | 'runs'>;

const PROVENANCE = { by: 'fleet', revision: 'a1b2c3d' };
const HOME = '/home/dev';

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

// A files record whose files each hash to their own path, so the hashes are stable.
const filesRecord = (name: string, paths: string[]) => ({
  files: paths.map((path) => ({ path, sha256: sha256Hex(path) })),
  name,
  provenance: PROVENANCE,
});

// A time as the whole-second UTC text a run carries.
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');

// `2026-10-06 12:00 UTC`, as the Hub's reasons write a time.
const utcMinute = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const supervisorCheck = (service: string, state: string, detail: string, since: number) => ({
  check: 'supervisor',
  detail,
  service,
  since,
  state,
});

// A run that started at `started` (epoch milliseconds) and took `minutes`, or
// until `now` if it is still within that span.
const runOf = (
  {
    exitStatus,
    minutes,
    now,
    started,
  }: Record<'exitStatus' | 'minutes' | 'now' | 'started', number>,
  output: { file: string; sizeBytes: number } | undefined,
) => ({
  exitStatus,
  finished: iso(Math.min(started + minutes * MINUTE, now)),
  ...(output === undefined ? {} : { output }),
  started: iso(started),
});

// When the seeded jobs last ran, and what they found, as milliseconds. The
// Conditions and the Reports both read these, so each failing run has its Condition.
const scenarioOf = (now: number) => {
  const borgStarted = Math.floor((now - 1.5 * HOUR) / DAY) * DAY + 1.5 * HOUR;
  const nightlyStarted = Math.floor((now - 2 * HOUR) / DAY) * DAY + 2 * HOUR;
  return {
    borgFinished: Math.min(borgStarted + 12 * MINUTE, now),
    borgStarted,
    dotfilesStarted: Math.floor(now / HOUR) * HOUR,
    driftSince: now - 26 * HOUR,
    // The server's log rotation last succeeded three runs ago, and its next
    // scheduled time, two days after that success, was missed.
    logRotateMissed: Math.floor((now - 2 * DAY) / DAY) * DAY + 3.5 * HOUR,
    nightlyFinished: Math.min(nightlyStarted + 30 * MINUTE, now),
    nightlyStarted,
    ollamaUpSince: now - 8.5 * HOUR,
  };
};
type Scenario = ReturnType<typeof scenarioOf>;

const WORKSTATION_DOTFILES = [
  '.bashrc',
  '.config/git/ignore',
  '.config/mise/config.toml',
  '.config/nvim/init.lua',
  '.config/starship.toml',
  '.gitconfig',
  '.inputrc',
  '.local/bin/backup-notes',
  '.tmux.conf',
  '.zshrc',
].map((path) => `${HOME}/${path}`);
const DRIFTED_DOTFILE = `${HOME}/.zshrc`;
const UNREADABLE_SYNCTHING_FILE = `${HOME}/.local/state/syncthing/config.xml`;

// Everything the workstation's provisioner recorded and its Collector observed:
// three Services, two jobs with their runs, four files records (one drifted
// path, one unreadable), six applications, and two Harness installs.
const workstationSections = async (now: number, scenario: Scenario) => {
  const dotfiles = filesRecord('dotfiles', WORKSTATION_DOTFILES);
  const sshConfig = filesRecord('ssh-config', [
    `${HOME}/.ssh/config`,
    `${HOME}/.ssh/allowed_signers`,
  ]);
  const userUnits = filesRecord(
    'systemd-user-units',
    ['dotfiles-pull.service', 'dotfiles-pull.timer', 'syncthing.service'].map(
      (unit) => `${HOME}/.config/systemd/user/${unit}`,
    ),
  );
  const syncthingConfig = filesRecord('syncthing-config', [UNREADABLE_SYNCTHING_FILE]);
  const filesRecords = [dotfiles, sshConfig, userUnits, syncthingConfig];

  const application = (name: string, version: string, source: string) => ({
    kind: 'application',
    name,
    record: { name, provenance: PROVENANCE, source, version },
  });
  const sent = [
    application('git', '2.51.0', 'apt'),
    application('neovim', '0.11.4', 'mise'),
    application('node', '24.9.0', 'mise'),
    application('ollama', '0.12.3', 'Docker image ollama/ollama'),
    application('ripgrep', '14.1.1', 'apt'),
    application('syncthing', '1.30.0', 'apt'),
    ...[
      {
        container: 'ollama',
        name: 'ollama',
        port: 11_434,
        provenance: PROVENANCE,
        supervisor: 'docker',
      },
      {
        health: 'http://127.0.0.1:8384/rest/noauth/health',
        name: 'syncthing',
        port: 8384,
        provenance: PROVENANCE,
        supervisor: 'systemd-user',
        unit: 'syncthing.service',
      },
      {
        name: 'heimdall-collector',
        provenance: PROVENANCE,
        supervisor: 'systemd-user',
        unit: 'heimdall-collector.service',
      },
    ].map((record) => ({ kind: 'service', name: record.name, record })),
    ...[
      {
        name: 'dotfiles-pull',
        provenance: PROVENANCE,
        schedule: [{ minute: 0 }],
        scheduler: 'systemd-timer',
        unit: 'dotfiles-pull.timer',
      },
      {
        name: 'borg-home',
        provenance: PROVENANCE,
        schedule: [{ hour: 1, minute: 30 }],
        scheduler: 'systemd-timer',
        unit: 'borg-home.timer',
      },
    ].map((record) => ({ kind: 'job', name: record.name, record })),
    ...filesRecords.map((record) => ({ kind: 'files', name: record.name, record })),
  ];

  const dotfilesRun = runOf(
    { exitStatus: 0, minutes: 0.1, now, started: scenario.dotfilesStarted },
    undefined,
  );
  const borgSucceeded = runOf(
    { exitStatus: 0, minutes: 14, now, started: scenario.borgStarted - DAY },
    { file: 'borg-home-previous.log', sizeBytes: 4096 },
  );
  const borgFailed = runOf(
    { exitStatus: 2, minutes: 12, now, started: scenario.borgStarted },
    { file: 'borg-home-latest.log', sizeBytes: 1800 },
  );

  return {
    checks: {
      fileRecords: await Promise.all(
        filesRecords.map(async (record) => ({
          digest: await filesRecordDigest(record),
          record: record.name,
        })),
      ),
      files: [
        {
          path: DRIFTED_DOTFILE,
          record: 'dotfiles',
          since: scenario.driftSince,
          state: 'drifted',
        },
        {
          path: UNREADABLE_SYNCTHING_FILE,
          record: 'syncthing-config',
          since: now - 3 * DAY,
          state: 'unreadable',
        },
      ],
      services: [
        supervisorCheck('ollama', 'up', 'status running', scenario.ollamaUpSince),
        supervisorCheck('syncthing', 'up', 'ActiveState=active', now - 4 * DAY),
        {
          check: 'health',
          detail: 'HTTP 200',
          service: 'syncthing',
          since: now - 4 * DAY,
          state: 'up',
        },
        supervisorCheck('heimdall-collector', 'up', 'ActiveState=active', now - 6 * DAY),
      ],
    },
    harnesses: {
      installs: [
        { harness: 'claude-code', location: 'native', version: '2.1.14' },
        { harness: 'codex', location: 'npm', version: '0.58.0' },
      ],
    },
    records: { records: sent, unreadable: [] },
    runs: {
      jobs: [
        { job: 'dotfiles-pull', latestRun: dotfilesRun, latestSuccess: dotfilesRun },
        { job: 'borg-home', latestRun: borgFailed, latestSuccess: borgSucceeded },
      ],
      unreadable: [],
    },
  } satisfies Provisioned;
};

// The server's recorded database container, stopped; its nightly backup, failing;
// its log rotation, overdue; and its config file, changed.
const serverSections = async (now: number, scenario: Scenario) => {
  const appConfig = filesRecord('app-config', ['/etc/app/config.toml', '/etc/app/secrets.env']);
  const succeeded = runOf(
    { exitStatus: 0, minutes: 28, now, started: scenario.nightlyStarted - DAY },
    undefined,
  );
  const failed = runOf(
    { exitStatus: 1, minutes: 30, now, started: scenario.nightlyStarted },
    undefined,
  );
  const devDb = {
    container: 'dev-db',
    name: 'dev-db',
    provenance: PROVENANCE,
    supervisor: 'docker',
  };
  const logRotateSucceeded = runOf(
    { exitStatus: 0, minutes: 2, now, started: scenario.logRotateMissed - DAY },
    undefined,
  );
  const logRotate = {
    name: 'log-rotate',
    provenance: PROVENANCE,
    schedule: [{ hour: 3, minute: 30 }],
    scheduler: 'systemd-timer',
    unit: 'log-rotate.timer',
  };
  const nightly = {
    name: 'nightly-backup',
    provenance: PROVENANCE,
    schedule: [{ hour: 2, minute: 0 }],
    scheduler: 'systemd-timer',
    unit: 'nightly-backup.timer',
  };

  return {
    checks: {
      fileRecords: [{ digest: await filesRecordDigest(appConfig), record: appConfig.name }],
      files: [
        {
          path: '/etc/app/config.toml',
          record: appConfig.name,
          since: scenario.driftSince,
          state: 'drifted',
        },
      ],
      services: [
        supervisorCheck('dev-db', 'stopped', 'status exited, exit code 137', now - 2 * HOUR),
      ],
    },
    records: {
      records: [
        { kind: 'service', name: devDb.name, record: devDb },
        { kind: 'job', name: nightly.name, record: nightly },
        { kind: 'job', name: logRotate.name, record: logRotate },
        { kind: 'files', name: appConfig.name, record: appConfig },
      ],
      unreadable: [],
    },
    runs: {
      jobs: [
        { job: nightly.name, latestRun: failed, latestSuccess: succeeded },
        { job: logRotate.name, latestRun: logRotateSucceeded, latestSuccess: logRotateSucceeded },
      ],
      unreadable: [],
    },
  } satisfies Provisioned;
};

// The laptop's checks, sent hours before its last Report and not repeated: they
// found its recorded Syncthing agent stopped, which no later check confirms.
const laptopEarlierSections = (now: number): Provisioned => ({
  checks: {
    fileRecords: [],
    files: [],
    services: [supervisorCheck('syncthing', 'stopped', 'last exit status 1', now - 7 * HOUR)],
  },
  records: {
    records: [
      {
        kind: 'service',
        name: 'syncthing',
        record: {
          label: 'com.syncthing.agent',
          name: 'syncthing',
          provenance: PROVENANCE,
          supervisor: 'launchd',
        },
      },
    ],
    unreadable: [],
  },
});

// The sections each System's last Report carries, by System name.
const provisionedBySystem = async (now: number) => {
  const scenario = scenarioOf(now);
  return new Map<string, Provisioned>([
    [SYSTEM, await workstationSections(now, scenario)],
    ['server-1', await serverSections(now, scenario)],
    // A Collector that looked for Harnesses and found none, unlike laptop-1's,
    // which never says.
    ['gateway-1', { harnesses: { installs: [] } }],
    [
      UNPAIRED_SYSTEM,
      { harnesses: { installs: [{ harness: 'codex', location: 'npm', version: '0.57.0' }] } },
    ],
  ]);
};

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
    cpuCores: 1.2,
    cwd: api,
    end: -hours(7),
    harness: 'claude-code',
    pid: 4101,
    readings: 'both',
    rssBytes: Math.round(2.4 * GIB),
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
    cpuCores: 0.6,
    cwd: web,
    end: -hours(3.5),
    harness: 'claude-code',
    pid: 4102,
    readings: 'both',
    rssBytes: Math.round(1.1 * GIB),
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
    cpuCores: 0.9,
    cwd: infra,
    end: -hours(4),
    harness: 'codex',
    pid: 4201,
    readings: 'both',
    rssBytes: Math.round(1.6 * GIB),
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
    cpuCores: 0.3,
    cwd: docs,
    end: -hours(1),
    harness: 'claude-code',
    pid: 4103,
    readings: 'both',
    rssBytes: Math.round(0.8 * GIB),
    start: -hours(2),
    system: SYSTEM,
  });
  await addProcess(sql, {
    cpuCores: 0.2,
    cwd: docs,
    end: -hours(1),
    harness: 'claude-code',
    pid: 4104,
    readings: 'both',
    rssBytes: Math.round(0.5 * GIB),
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

// One long Session shaped like real agent work, for the Session page: a main
// conversation on Opus with subagents on Sonnet, one with a subagent of its
// own; a workflow run; skills, tool calls, and slash commands; a /compact that
// shrinks the context; waits on the person and an interrupted response; and a
// process link that is linked, then ambiguous, then linked to a new process
// after the first exits. Times are seconds before `now`.
const seedWorkSession = async (sql: SQL, now: number) => {
  const { addProcess, addSession } = timeline(now);
  const random = noise(4099);
  const between = (low: number, high: number) => low + ((random() + 1) / 2) * (high - low);
  const cwd = `${HOME}/src/heimdall`;
  const start = -hours(3.4);
  const minute = (m: number) => start + m * 60;
  const opus = 'claude-opus-5-5';
  const sonnet = 'claude-sonnet-5-5';
  const tools: [string, string?][] = [
    ['Read'],
    ['Read'],
    ['Read'],
    ['Bash'],
    ['Bash'],
    ['Grep'],
    ['Edit'],
    ['Glob'],
    ['Write'],
    ['TodoWrite'],
    ['codegraph_explore', 'codegraph'],
  ];
  const process = { harness: 'claude-code', readings: 'both', system: SYSTEM } as const;

  await addProcess(sql, {
    ...process,
    cpuCores: 0.8,
    cwd,
    end: minute(66),
    pid: 48_211,
    rssBytes: Math.round(1.8 * GIB),
    start: minute(-1),
  });
  // A second process in the same directory while the first still runs.
  await addProcess(sql, {
    ...process,
    cpuCores: 0.3,
    cwd,
    end: minute(70),
    pid: 49_002,
    rssBytes: Math.round(0.6 * GIB),
    start: minute(40),
  });
  await addProcess(sql, {
    ...process,
    cpuCores: 0.6,
    cwd,
    end: minute(140),
    pid: 50_122,
    rssBytes: Math.round(1.4 * GIB),
    start: minute(82),
  });

  // The main conversation: a request every 15 to 90 seconds, but for two waits
  // on the person and the gap after the first process exits. Its context
  // grows with each request until /compact.
  const waits = [
    [45.5, 49],
    [124, 128.5],
  ];
  const gaps = [...waits, [66, 82.6]];
  const compactAt = 82.67;
  const main: RequestFixture[] = [];
  let context = 26_000;
  let compacted = false;
  for (let m = 0.2; m < 132; m += between(0.25, 1.5)) {
    const gap = gaps.find(([from = 0, to = 0]) => m > from && m < to);
    if (gap !== undefined) {
      m = gap[1] ?? m;
    }
    if (!compacted && m > compactAt) {
      context = 52_000;
      compacted = true;
    }
    context += between(300, 2500);
    const inputTokens = Math.round(between(100, 2500));
    const cacheWriteTokens = Math.round(between(300, 3000));
    main.push({
      at: minute(m),
      cacheReadTokens: Math.round(context) - inputTokens - cacheWriteTokens,
      cacheWriteTokens,
      inputTokens,
      model: opus,
      outputTokens: Math.round(between(150, 6000)),
      ...(m >= 14 && m < 82 && { skill: 'tdd' }),
      ...(m >= 94 && { skill: 'code-review' }),
      stopReason: random() > 0.94 ? null : 'tool_use',
    });
  }
  // The request before each wait finished its turn.
  for (const [from = 0] of waits) {
    const before = main.findLast((request) => request.at < minute(from));
    if (before !== undefined) {
      before.stopReason = 'end_turn';
    }
  }

  // A subagent's requests, evenly over its span with some jitter.
  const agent = (model: string, from: number, to: number, count: number) =>
    Array.from({ length: count }, (_, i): RequestFixture => {
      const inputTokens = Math.round(between(200, 3000));
      return {
        at: minute(from + ((to - from) * (i + 0.5 + between(-0.3, 0.3))) / count),
        cacheReadTokens: Math.round(10_000 + i * between(500, 2500)),
        cacheWriteTokens: Math.round(between(200, 2500)),
        inputTokens,
        model,
        outputTokens: Math.round(between(100, 2500)),
        stopReason: i === count - 1 ? 'end_turn' : 'tool_use',
      };
    });
  const subagents: (SubagentFixture & { requests: RequestFixture[] })[] = [
    { agentId: 'explore-1', agentType: 'Explore', requests: agent(sonnet, 4, 9, 20) },
    { agentId: 'explore-2', agentType: 'Explore', requests: agent(sonnet, 4.2, 11, 21) },
    { agentId: 'general-1', agentType: 'general-purpose', requests: agent(sonnet, 32, 61, 65) },
    {
      agentId: 'explore-3',
      agentType: 'Explore',
      depth: 2,
      parentAgentId: 'general-1',
      requests: agent(sonnet, 38, 42, 17),
    },
    ...[
      { count: 41, id: 'review-1', model: opus, phase: 'Review', span: [95, 109] },
      { count: 26, id: 'review-2', model: opus, phase: 'Review', span: [95.2, 106] },
      { count: 16, id: 'verify-1', model: sonnet, phase: 'Verify', span: [110, 117] },
    ].map(({ count, id, model, phase, span: [from = 0, to = 0] }) => ({
      agentId: id,
      agentType: 'general-purpose',
      requests: agent(model, from, to, count),
      workflowPhase: phase,
      workflowRun: 'wf-7c1e2a',
    })),
  ];

  // One to three tool calls in each request that called tools.
  const callsOf = (requests: RequestFixture[], agentId?: string): ToolCallFixture[] =>
    requests.flatMap((request, requestIndex) =>
      request.stopReason === 'tool_use'
        ? Array.from({ length: Math.round(between(1, 3)) }, (_, i) => {
            const [name = 'Read', mcpServer] =
              tools[Math.floor(((random() + 1) / 2) * tools.length)] ?? [];
            return {
              ...(agentId !== undefined && { agentId }),
              at: request.at + i,
              ...(mcpServer !== undefined && { mcpServer }),
              name,
              requestIndex,
            };
          })
        : [],
    );

  await addSession(sql, {
    firstCwd: cwd,
    gitBranch: 'hmd-82-system-detail',
    harness: 'claude-code',
    harnessVersion: '2.1.40',
    id: '7f3c9a2e-5d41-4b8e-9c07-2a6f1e3b8d90',
    lastCwd: cwd,
    model: opus,
    requests: main,
    subagents,
    system: SYSTEM,
    toolCalls: [
      ...callsOf(main),
      ...subagents.flatMap((subagent) => callsOf(subagent.requests, subagent.agentId)),
      { at: minute(compactAt), kind: 'command', name: 'compact' },
      { at: minute(94.3), kind: 'command', name: 'code-review' },
    ],
  });
};

// How the Hub's reason names a run that failed, up to its exit status.
const failedRun = (started: number) => `The run started ${iso(started)} exited with status`;

// The Conditions the Hub would hold for the seeded records and runs, with the
// reasons it writes, and a few cleared ones spread over the week so a Timeline
// has entries. Times are seconds before `now`.
const seedConditions = async (sql: SQL, now: number) => {
  const { addCondition } = timeline(now);
  const scenario = scenarioOf(now);
  const secondsFromNow = (ms: number) => (ms - now) / SECOND;
  const conditions: Parameters<typeof addCondition>[1][] = [];

  conditions.push({
    kind: 'job_failing',
    raisedAt: secondsFromNow(scenario.borgFinished),
    reason: `${failedRun(scenario.borgStarted)} 2.`,
    subject: 'borg-home',
    system: SYSTEM,
  });
  conditions.push({
    kind: 'drift',
    raisedAt: secondsFromNow(scenario.driftSince + 5 * MINUTE),
    reason: 'Changed: its content no longer matches the hash recorded in dotfiles.',
    subject: DRIFTED_DOTFILE,
    system: SYSTEM,
  });
  conditions.push({
    clearedAt: -hours(8.5),
    kind: 'service_down',
    raisedAt: -hours(9),
    reason: 'Stopped: status exited, exit code 137.',
    subject: 'ollama',
    system: SYSTEM,
  });
  conditions.push({
    clearedAt: -(4.8 * DAY) / SECOND,
    kind: 'low_disk',
    raisedAt: -(5 * DAY) / SECOND,
    reason: '45.0 GiB free of 500.0 GiB (9.0%).',
    subject: '/',
    system: SYSTEM,
  });
  const overdueScheduled = Math.floor((now - 3.2 * DAY) / HOUR) * HOUR;
  conditions.push({
    clearedAt: secondsFromNow(overdueScheduled + HOUR + 20 * MINUTE),
    kind: 'job_overdue',
    raisedAt: secondsFromNow(overdueScheduled + HOUR),
    reason: `Scheduled for ${utcMinute(overdueScheduled)}; no successful run since.`,
    subject: 'dotfiles-pull',
    system: SYSTEM,
  });
  const staleRaised = now - 2.4 * DAY;
  conditions.push({
    clearedAt: secondsFromNow(staleRaised + 25 * MINUTE),
    kind: 'system_stale',
    raisedAt: secondsFromNow(staleRaised),
    reason: `Not heard from since ${utcMinute(staleRaised - 11 * MINUTE)}, more than 10 minutes ago.`,
    system: SYSTEM,
  });

  conditions.push({
    kind: 'job_failing',
    raisedAt: secondsFromNow(scenario.nightlyFinished),
    reason: `${failedRun(scenario.nightlyStarted)} 1.`,
    subject: 'nightly-backup',
    system: 'server-1',
  });
  conditions.push({
    kind: 'drift',
    raisedAt: secondsFromNow(scenario.driftSince + 5 * MINUTE),
    reason: 'Changed: its content no longer matches the hash recorded in app-config.',
    subject: '/etc/app/config.toml',
    system: 'server-1',
  });
  conditions.push({
    kind: 'service_down',
    raisedAt: -hours(1.9),
    reason: 'Stopped: status exited, exit code 137.',
    subject: 'dev-db',
    system: 'server-1',
  });
  conditions.push({
    kind: 'job_overdue',
    raisedAt: secondsFromNow(scenario.logRotateMissed + HOUR),
    reason: `Scheduled for ${utcMinute(scenario.logRotateMissed)}; no successful run since.`,
    subject: 'log-rotate',
    system: 'server-1',
  });
  // The laptop's one Condition rests on checks that arrived 7 hours ago.
  conditions.push({
    kind: 'service_down',
    raisedAt: -hours(7),
    reason: 'Stopped: last exit status 1.',
    subject: 'syncthing',
    system: 'laptop-1',
  });
  conditions.push({
    kind: 'low_disk',
    raisedAt: -hours(5),
    reason: '/ is 94% full',
    subject: '/',
    system: 'gateway-1',
  });
  conditions.push({
    kind: 'low_disk',
    raisedAt: -hours(3),
    reason: '120.0 GiB free of 4000.0 GiB (3.0%).',
    subject: '/backup',
    system: SYSTEM,
  });
  // The unpaired System keeps the Conditions it left open, and its history.
  conditions.push({
    clearedAt: -(3 * DAY) / SECOND,
    kind: 'low_disk',
    raisedAt: -(4 * DAY) / SECOND,
    reason: '20.0 GiB free of 250.0 GiB (8.0%).',
    subject: '/',
    system: UNPAIRED_SYSTEM,
  });
  conditions.push({
    kind: 'job_overdue',
    raisedAt: -hours(30),
    reason: `Scheduled for ${utcMinute(Math.floor((now - 30 * HOUR) / HOUR) * HOUR)}; no successful run since.`,
    subject: 'nightly-image',
    system: UNPAIRED_SYSTEM,
  });
  // Oldest raised first, the order a Hub receives them, which orders the Timeline.
  for (const condition of conditions.toSorted((a, b) => a.raisedAt - b.raisedAt)) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of rows, in order.
    await addCondition(sql, condition);
  }
};

// Every table the seed writes. Truncating `systems` cascades to the rest.
const TABLES = [
  'systems',
  'paired_systems',
  'projected_sessions',
  'projected_subagents',
  'projected_requests',
  'projected_tool_calls',
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
    // oxlint-disable-next-line no-await-in-loop -- five Systems.
    await storeToken(sql, { pairedAt: now - 8 * DAY, system: name, token: `seed-token-${name}` });
  }
  const provisioned = await provisionedBySystem(now);
  // Sections some Systems sent hours before their last Report, so the evidence
  // behind their Conditions is old.
  const earlier = new Map([['laptop-1', laptopEarlierSections(now)]]);
  await Promise.all(
    PROFILES.map((profile) =>
      sendVitals(sql, profile, now, {
        earlier: earlier.get(profile.name),
        provisioned: provisioned.get(profile.name),
      }),
    ),
  );
  await seedConditions(sql, now);
  await seedSessions(sql, now);
  await seedWorkSession(sql, now);
  await unpair(sql, UNPAIRED_SYSTEM);
  // Stores the seeded Sessions' stretches and totals, as a running Hub would.
  await refreshSessionInsight(sql, { budgetMs: Number.POSITIVE_INFINITY });
  const overview = await readFleetOverview(sql, {
    now,
    range: '24h',
    unpaired: true,
  });
  for (const lane of [...overview.lanes, ...overview.unpairedLanes]) {
    console.log(
      `${lane.name}: ${lane.status}, ${lane.buckets.length} buckets, ${lane.gaps.length} gaps, ${lane.stretches.length} stretches, ${lane.conditions.length} Condition marks`,
    );
  }
  const confirmed = overview.attention.filter(({ evidence }) => evidence === 'current');
  console.log(
    `${confirmed.length} confirmed and ${overview.attention.length - confirmed.length} unconfirmed items need you.`,
  );
};

const configured = process.env.HEIMDALL_DATABASE_URL;
if (configured === undefined || configured === '') {
  console.error('Set HEIMDALL_DATABASE_URL to a scratch PostgreSQL database for the seed to fill.');
  process.exit(1);
}
await seed(new URL(configured));
