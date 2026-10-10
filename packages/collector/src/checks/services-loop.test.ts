import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ServiceRecord } from '@heimdall/schema';
import type { HttpGet } from '@heimdall/service';

import { openRecords } from '../records.ts';
import type { RecordStore } from '../records.ts';
import type { CommandResult } from '../subprocess.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { createServiceChecks, startServiceChecks } from './services-loop.ts';

const START = Date.parse('2026-10-10T08:00:00Z');

const WEB: ServiceRecord = { name: 'web', supervisor: 'systemd', unit: 'web.service' };
const DB: ServiceRecord = { name: 'db', supervisor: 'systemd', unit: 'db.service' };

const shown = (active: string): CommandResult => ({
  exitCode: 0,
  kind: 'exited',
  stderr: '',
  stdout: `LoadState=loaded\nActiveState=${active}\nSubState=x\n`,
});

// The Service checks over a Collector's records in a fresh state directory,
// with a fake systemctl that answers per unit from `states` and a clock the
// test sets. `elsewhere` changes the records through a connection of their
// own, as `record` and `forget` do.
const setup = async (
  dir: { path: string },
  {
    docker,
    httpGet,
    open,
    run,
  }: {
    docker?: 'real';
    httpGet?: HttpGet;
    open?: () => Promise<RecordStore>;
    run?: (cmd: readonly string[]) => Promise<CommandResult>;
  } = {},
) => {
  const warnings: string[] = [];
  const states = new Map<string, string>();
  let now = START;
  const checks = createServiceChecks({
    // 'real' leaves the option out, as production does, so the environment decides.
    ...(docker === 'real'
      ? {}
      : { docker: { endpoint: { host: 'tcp://127.0.0.1:1', kind: 'unsupported' } as const } }),
    findSystemctl: () => Promise.resolve('/usr/bin/systemctl'),
    ...(httpGet === undefined ? {} : { httpGet }),
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    now: () => now,
    open: open ?? (() => openRecords({ stateDir: join(dir.path, 'state') })),
    run:
      run ??
      ((cmd) => {
        const active = states.get(cmd.at(-1) ?? '');
        return Promise.resolve(active === undefined ? shown('inactive') : shown(active));
      }),
  });
  const elsewhere = async (change: (store: RecordStore) => void) => {
    const other = await openRecords({ stateDir: join(dir.path, 'state') });
    change(other);
    other.close();
  };
  return {
    advance: (ms: number) => {
      now += ms;
    },
    checks,
    elsewhere,
    now: () => now,
    states,
    warnings,
  };
};

const sent = (service: string, state: string, detail: string, since: number) => ({
  check: 'supervisor',
  detail,
  service,
  since,
  state,
});

test('no services part exists until the first pass has run', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);

  expect(c.checks.latest()).toBeUndefined();
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({ services: [] });
});

test('checks the supervisor of every service record, and nothing else', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  c.states.set('web.service', 'active');
  c.states.set('db.service', 'failed');
  await c.elsewhere((store) => {
    store.put('service', WEB);
    store.put('service', DB);
    store.put('application', { name: 'web', version: '1' });
  });

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [
      sent('db', 'stopped', 'ActiveState=failed', START),
      sent('web', 'up', 'ActiveState=active', START),
    ],
  });
});

// Needs an account id to name the gui domain with, which Windows has not.
test.skipIf(process.getuid === undefined)(
  'asks launchd about a launchd service in the gui domain of the account the Collector runs as',
  async () => {
    await using dir = await tempStateDir();
    const asked: string[][] = [];
    const c = await setup(dir, {
      run: (cmd) => {
        asked.push([...cmd]);
        return Promise.resolve<CommandResult>({
          exitCode: 113,
          kind: 'exited',
          stderr: 'Could not find service "com.example.web" in domain for user gui',
          stdout: '',
        });
      },
    });
    await c.elsewhere((store) =>
      store.put('service', { label: 'com.example.web', name: 'web', supervisor: 'launchd' }),
    );

    await c.checks.tick();
    c.checks.close();

    expect(asked).toEqual([
      ['/bin/launchctl', 'print', `gui/${String(process.getuid?.())}/com.example.web`],
      ['/bin/launchctl', 'print', 'system/com.example.web'],
    ]);
  },
);

test('a check keeps its since time while its state holds, and takes a new one when the state changes', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  c.states.set('web.service', 'failed');
  await c.elsewhere((store) => store.put('service', WEB));
  await c.checks.tick();

  c.advance(60_000);
  c.states.set('web.service', 'inactive');
  await c.checks.tick();
  const stillStopped = c.checks.latest();
  c.advance(60_000);
  c.states.set('web.service', 'active');
  await c.checks.tick();
  c.checks.close();

  expect(stillStopped).toEqual({
    services: [sent('web', 'stopped', 'ActiveState=inactive', START)],
  });
  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'up', 'ActiveState=active', START + 120_000)],
  });
});

test('a check keeps the since time of its latest state across ticks, after a change', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) => store.put('service', WEB));
  c.states.set('web.service', 'active');
  await c.checks.tick();

  c.advance(60_000);
  c.states.set('web.service', 'failed');
  await c.checks.tick();
  c.advance(60_000);
  await c.checks.tick();
  c.advance(60_000);
  await c.checks.tick();
  const stopped = c.checks.latest();
  c.advance(60_000);
  c.states.set('web.service', 'active');
  await c.checks.tick();
  c.advance(60_000);
  await c.checks.tick();
  c.checks.close();

  expect(stopped).toEqual({
    services: [sent('web', 'stopped', 'ActiveState=failed', START + 60_000)],
  });
  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'up', 'ActiveState=active', START + 240_000)],
  });
});

test.each([
  ['unit', { name: 'web', supervisor: 'systemd', unit: 'b.service' }],
  ['supervisor', { name: 'web', supervisor: 'systemd-user', unit: 'web.service' }],
] as const)(
  'a service recorded again with another %s starts a fresh since time',
  async (_, again) => {
    await using dir = await tempStateDir();
    const c = await setup(dir);
    await c.elsewhere((store) => store.put('service', WEB));
    await c.checks.tick();
    c.advance(60_000);
    await c.checks.tick();
    const before = c.checks.latest();

    c.advance(60_000);
    await c.elsewhere((store) => store.put('service', again));
    await c.checks.tick();
    c.checks.close();

    expect(before).toEqual({
      services: [sent('web', 'stopped', 'ActiveState=inactive', START)],
    });
    expect(c.checks.latest()).toEqual({
      services: [sent('web', 'stopped', 'ActiveState=inactive', START + 120_000)],
    });
  },
);

test('a pass that fails leaves no services part, and the next pass that works starts every since time afresh', async () => {
  await using dir = await tempStateDir();
  let failing = false;
  const c = await setup(dir, {
    open: async () => {
      const store = await openRecords({ stateDir: join(dir.path, 'state') });
      return {
        ...store,
        readRecords: () => {
          if (failing) {
            throw new Error('database is locked');
          }
          return store.readRecords();
        },
      };
    },
  });
  await c.elsewhere((store) => store.put('service', WEB));
  await c.checks.tick();
  const before = c.checks.latest();

  c.advance(60_000);
  failing = true;
  await c.checks.tick();
  const during = c.checks.latest();
  c.advance(60_000);
  failing = false;
  await c.checks.tick();
  c.checks.close();

  expect(before).toEqual({ services: [sent('web', 'stopped', 'ActiveState=inactive', START)] });
  expect(during).toBeUndefined();
  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'stopped', 'ActiveState=inactive', START + 120_000)],
  });
});

test('answers the same object while nothing about the checks changed, so nothing is sent again', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  c.states.set('web.service', 'failed');
  await c.elsewhere((store) => store.put('service', WEB));
  await c.checks.tick();
  const first = c.checks.latest();

  c.advance(60_000);
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toBe(first);
});

test('a forgotten service leaves the part', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) => store.put('service', WEB));
  await c.checks.tick();

  await c.elsewhere((store) => store.forget('service', 'web'));
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({ services: [] });
});

test('a service whose supervisor is not checked yet is unchecked', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) => store.put('service', { name: 'web', supervisor: 'none' }));

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'unchecked', 'none is not checked', START)],
  });
});

test('a docker service is checked at the DOCKER_HOST of the real environment when no endpoint is given', async () => {
  const kept = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = 'ssh://elsewhere.example';
  try {
    await using dir = await tempStateDir();
    const c = await setup(dir, { docker: 'real' });
    await c.elsewhere((store) =>
      store.put('service', { container: 'web', name: 'web', supervisor: 'docker' }),
    );

    await c.checks.tick();
    c.checks.close();

    expect(c.checks.latest()).toEqual({
      services: [sent('web', 'unknown', 'DOCKER_HOST is not a unix socket', START)],
    });
  } finally {
    if (kept === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = kept;
    }
  }
});

test('a docker service is checked through the Docker endpoint', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) =>
    store.put('service', { container: 'web', name: 'web', supervisor: 'docker' }),
  );

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'unknown', 'DOCKER_HOST is not a unix socket', START)],
  });
});

test('a store that will not open costs the checks, warned about once, and the next tick tries again', async () => {
  await using dir = await tempStateDir();
  let attempts = 0;
  const c = await setup(dir, {
    open: () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error('disk I/O error'))
        : openRecords({ stateDir: join(dir.path, 'state') });
    },
  });

  await c.checks.tick();
  await c.checks.tick();
  const failing = c.checks.latest();
  await c.checks.tick();
  c.checks.close();

  expect(failing).toBeUndefined();
  expect(c.warnings).toHaveLength(1);
  expect(c.warnings[0]).toContain('disk I/O error');
  expect(c.checks.latest()).toEqual({ services: [] });
});

test('a service row stored under another name is left out and warned about once', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) => store.put('service', WEB));
  const db = new Database(join(dir.path, 'state', 'records.sqlite'));
  db.run('INSERT INTO records (kind, name, body) VALUES (?, ?, ?)', [
    'service',
    'renamed',
    JSON.stringify(DB),
  ]);
  db.close();

  await c.checks.tick();
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [sent('web', 'stopped', 'ActiveState=inactive', START)],
  });
  expect(c.warnings).toEqual([expect.stringContaining('"renamed"')]);
});

test('started, it checks again each interval until stopped', async () => {
  await using dir = await tempStateDir();
  let ticks = 0;
  const checks = startServiceChecks({
    intervalMs: 10,
    log: { info: () => 0, warn: () => 0 },
    now: () => {
      ticks += 1;
      return START;
    },
    open: () => openRecords({ stateDir: join(dir.path, 'state') }),
  });

  await Bun.sleep(100);
  await checks.stop();
  const count = ticks;
  await Bun.sleep(50);

  expect(count).toBeGreaterThan(1);
  expect(ticks).toBe(count);
  expect(checks.latest()).toEqual({ services: [] });
});

test('a health check keeps its own since time beside the supervisor check', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  let status = 200;
  const server = Bun.serve({
    fetch: () => new Response('', { status }),
    hostname: '127.0.0.1',
    port: 0,
  });
  try {
    const health = `http://127.0.0.1:${String(server.port)}/healthz`;
    c.states.set('web.service', 'active');
    await c.elsewhere((store) => store.put('service', { ...WEB, health }));
    await c.checks.tick();

    c.advance(60_000);
    status = 503;
    await c.checks.tick();
    c.checks.close();

    expect(c.checks.latest()).toEqual({
      services: [
        sent('web', 'up', 'ActiveState=active', START),
        { ...sent('web', 'unhealthy', 'HTTP 503', START + 60_000), check: 'health' },
      ],
    });
  } finally {
    await server.stop(true);
  }
});

test('the loop gives a health URL 5 seconds, reading no body', async () => {
  await using dir = await tempStateDir();
  const asked: Parameters<HttpGet>[] = [];
  const c = await setup(dir, {
    httpGet: (target, options) => {
      asked.push([target, options]);
      return Promise.resolve({ kind: 'failed', message: 'no answer', reason: 'timeout' });
    },
  });
  c.states.set('web.service', 'active');
  await c.elsewhere((store) => store.put('service', { ...WEB, health: 'http://127.0.0.1:8080/h' }));

  await c.checks.tick();
  c.checks.close();

  expect(asked).toEqual([
    [
      { host: '127.0.0.1', path: '/h', port: 8080 },
      { maxBodyBytes: 0, timeoutMs: 5000 },
    ],
  ]);
  expect(c.checks.latest()).toMatchObject({
    services: [
      { check: 'supervisor', state: 'up' },
      { check: 'health', detail: 'timed out after 5 s', state: 'unhealthy' },
    ],
  });
});

test('a service recorded again with another health URL starts a fresh since time for its health check only', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir, {
    httpGet: () => Promise.resolve({ body: '', kind: 'response', status: 503, truncated: true }),
  });
  c.states.set('web.service', 'active');
  await c.elsewhere((store) => store.put('service', { ...WEB, health: 'http://127.0.0.1:8080/h' }));
  await c.checks.tick();

  c.advance(60_000);
  await c.elsewhere((store) => store.put('service', { ...WEB, health: 'http://127.0.0.1:9090/h' }));
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    services: [
      sent('web', 'up', 'ActiveState=active', START),
      { ...sent('web', 'unhealthy', 'HTTP 503', START + 60_000), check: 'health' },
    ],
  });
});
