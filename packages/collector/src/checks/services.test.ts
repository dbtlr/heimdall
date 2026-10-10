import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { MAX_CHECK_DETAIL_LENGTH } from '@heimdall/schema';
import type { ServiceRecord } from '@heimdall/schema';
import { httpGet } from '@heimdall/service';
import type { HttpGet } from '@heimdall/service';

import type { CommandResult } from '../subprocess.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { checkService, findSystemctl } from './services.ts';

const SYSTEMCTL = '/usr/bin/systemctl';

// A Docker endpoint these tests never reach: a Docker Service is tested apart.
const UNREACHABLE_DOCKER = { host: 'tcp://127.0.0.1:1', kind: 'unsupported' } as const;

const WEB: ServiceRecord = { name: 'web', supervisor: 'systemd', unit: 'web.service' };
const WEB_USER: ServiceRecord = { name: 'web', supervisor: 'systemd-user', unit: 'web.service' };

// What `systemctl show` prints for a unit in the given states, in the order
// systemd prints them.
const shown = (states: { active: string; load?: string; sub?: string }): CommandResult => ({
  exitCode: 0,
  kind: 'exited',
  stderr: '',
  stdout: `LoadState=${states.load ?? 'loaded'}\nActiveState=${states.active}\nSubState=${states.sub ?? 'running'}\n`,
});

// One unit's block of `systemctl show` output.
const block = (active: string) => `LoadState=loaded\nActiveState=${active}\nSubState=running\n`;

const failed = (exitCode: number, stderr: string): CommandResult => ({
  exitCode,
  kind: 'exited',
  stderr,
  stdout: '',
});

// Checks `record` with a fake systemctl that answers `result`, and answers what
// the check found and the commands it ran.
const check = async (
  record: ServiceRecord,
  result: CommandResult | Error,
  options: { systemctl?: string | undefined } = {},
) => {
  const ran: string[][] = [];
  const outcomes = await checkService(record, {
    httpGet,
    run: (cmd) => {
      ran.push([...cmd]);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    docker: { endpoint: UNREACHABLE_DOCKER },
    systemctl: 'systemctl' in options ? options.systemctl : SYSTEMCTL,
  });
  return { outcomes, ran };
};

describe('a systemd Service', () => {
  test('is up when its unit is active', async () => {
    const { outcomes } = await check(WEB, shown({ active: 'active' }));

    expect(outcomes).toEqual([{ check: 'supervisor', detail: 'ActiveState=active', state: 'up' }]);
  });

  test('is up when its unit is active but exited, as a oneshot that remains after exit is', async () => {
    const { outcomes } = await check(WEB, shown({ active: 'active', sub: 'exited' }));

    expect(outcomes).toMatchObject([{ state: 'up' }]);
  });

  test.each(['failed', 'inactive', 'activating', 'deactivating', 'reloading'])(
    'is stopped when its unit is %s',
    async (active) => {
      const { outcomes } = await check(WEB, shown({ active, sub: 'dead' }));

      expect(outcomes).toEqual([
        { check: 'supervisor', detail: `ActiveState=${active}`, state: 'stopped' },
      ]);
    },
  );

  test('is stopped when systemd does not know the unit', async () => {
    const { outcomes } = await check(
      WEB,
      shown({ active: 'inactive', load: 'not-found', sub: 'dead' }),
    );

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'LoadState=not-found', state: 'stopped' },
    ]);
  });

  test('asks the system manager for the unit by the absolute path of systemctl', async () => {
    const { ran } = await check(WEB, shown({ active: 'active' }));

    expect(ran).toEqual([
      [SYSTEMCTL, 'show', '--property=ActiveState,SubState,LoadState', '--', 'web.service'],
    ]);
  });

  test('is unknown when systemctl cannot reach systemd, and the detail says so', async () => {
    const { outcomes } = await check(
      WEB,
      failed(1, 'System has not been booted with systemd as init system (PID 1). Cannot operate.'),
    );

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'systemd not running', state: 'unknown' },
    ]);
  });

  test('is unknown when systemctl exits non-zero for a reason that is not a unit state', async () => {
    const { outcomes } = await check(WEB, failed(4, 'Access denied'));

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'systemctl exited 4', state: 'unknown' },
    ]);
  });

  test('is unknown when systemctl times out', async () => {
    const { outcomes } = await check(WEB, { kind: 'timed out' });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'systemctl timed out', state: 'unknown' },
    ]);
  });

  test('is unknown when systemctl answers without the states asked for', async () => {
    const { outcomes } = await check(WEB, {
      exitCode: 0,
      kind: 'exited',
      stderr: '',
      stdout: 'ActiveState=active\n',
    });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'unexpected systemctl output', state: 'unknown' },
    ]);
  });

  test.each([
    ['SubState', 'LoadState=loaded\nActiveState=active\n'],
    ['LoadState', 'ActiveState=active\nSubState=running\n'],
    ['ActiveState', 'LoadState=loaded\nSubState=running\n'],
  ])('is unknown when systemctl answers without %s', async (_, stdout) => {
    const { outcomes } = await check(WEB, { exitCode: 0, kind: 'exited', stderr: '', stdout });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'unexpected systemctl output', state: 'unknown' },
    ]);
  });

  test('is unknown when systemctl answers for more than one unit, as it does for a name that matches several', async () => {
    const { outcomes } = await check(WEB, {
      exitCode: 0,
      kind: 'exited',
      stderr: '',
      stdout: `${block('failed')}\n${block('active')}`,
    });

    expect(outcomes).toEqual([
      {
        check: 'supervisor',
        detail: 'systemctl answered for more than one unit',
        state: 'unknown',
      },
    ]);
  });

  test('is unknown when systemctl answers for no unit, as it does for a name that matches none', async () => {
    const { outcomes } = await check(WEB, { exitCode: 0, kind: 'exited', stderr: '', stdout: '' });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'systemctl answered for no unit', state: 'unknown' },
    ]);
  });

  test('is not read as a bus failure because a unit name echoed by systemctl contains "bus"', async () => {
    const { outcomes } = await check(
      WEB,
      failed(1, 'Failed to get properties: Access denied for unit dbus@.service'),
    );

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'systemctl exited 1', state: 'unknown' },
    ]);
  });

  test('keeps its detail within what the Hub takes', async () => {
    const { outcomes } = await check(WEB, shown({ active: 'x'.repeat(500) }));

    expect(outcomes).toMatchObject([{ state: 'stopped' }]);
    expect(outcomes[0]?.detail).toHaveLength(MAX_CHECK_DETAIL_LENGTH);
    expect(outcomes[0]?.detail.startsWith('ActiveState=xxx')).toBe(true);
  });

  test('keeps control characters out of its detail', async () => {
    const { outcomes } = await check(WEB, shown({ active: 'fa\u0000il\u001b' }));

    expect(outcomes[0]?.detail).toBe('ActiveState=fail');
  });

  test('is unknown when systemctl cannot be started', async () => {
    const { outcomes } = await check(WEB, new Error('ENOENT'));

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'systemctl could not run', state: 'unknown' },
    ]);
  });

  test('is unknown when there is no systemctl to run', async () => {
    const { outcomes, ran } = await check(WEB, shown({ active: 'active' }), {
      systemctl: undefined,
    });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'systemctl not found', state: 'unknown' },
    ]);
    expect(ran).toEqual([]);
  });
});

describe('a systemd-user Service', () => {
  test('is asked of the user manager', async () => {
    const { outcomes, ran } = await check(WEB_USER, shown({ active: 'active' }));

    expect(outcomes).toMatchObject([{ state: 'up' }]);
    expect(ran).toEqual([
      [
        SYSTEMCTL,
        '--user',
        'show',
        '--property=ActiveState,SubState,LoadState',
        '--',
        'web.service',
      ],
    ]);
  });

  test.each([
    'Failed to connect to bus: No medium found',
    'Failed to connect to user scope bus via local transport: No such file or directory',
    'Failed to get D-Bus connection: No such file or directory',
  ])('is unknown, not stopped, when the account has no user bus (%s)', async (stderr) => {
    const { outcomes } = await check(WEB_USER, failed(1, stderr));

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'bus unavailable', state: 'unknown' },
    ]);
  });

  test('is stopped when the user manager runs and its unit failed', async () => {
    const { outcomes } = await check(WEB_USER, shown({ active: 'failed' }));

    expect(outcomes).toMatchObject([{ state: 'stopped' }]);
  });
});

describe('a Service whose supervisor this Collector does not check yet', () => {
  test.each([
    ['none', { name: 'web', supervisor: 'none' }],
  ] as const)('is unchecked under %s, not down, and nothing is run', async (supervisor, record) => {
    const { outcomes, ran } = await check(record, shown({ active: 'failed' }));

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: `${supervisor} is not checked`, state: 'unchecked' },
    ]);
    expect(ran).toEqual([]);
  });
});

describe('a docker Service', () => {
  const WEB_CONTAINER: ServiceRecord = { container: 'web', name: 'web', supervisor: 'docker' };

  test('is checked through the Docker endpoint, and runs no command', async () => {
    const ran: string[][] = [];
    const outcomes = await checkService(WEB_CONTAINER, {
      docker: { endpoint: UNREACHABLE_DOCKER },
      run: (cmd) => {
        ran.push([...cmd]);
        return Promise.reject(new Error('no command expected'));
      },
      systemctl: SYSTEMCTL,
    });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'DOCKER_HOST is not a unix socket', state: 'unknown' },
    ]);
    expect(ran).toEqual([]);
  });

  test('is stopped when the container is gone, as a supervisor check', async () => {
    await using dir = await tempStateDir();
    const unix = join(dir.path, 'docker.sock');
    const server = Bun.serve({ fetch: () => new Response('{}', { status: 404 }), unix });
    try {
      const outcomes = await checkService(WEB_CONTAINER, {
        docker: { endpoint: { kind: 'unix', path: unix } },
        run: () => Promise.reject(new Error('no command expected')),
        systemctl: undefined,
      });

      expect(outcomes).toEqual([
        { check: 'supervisor', detail: 'no such container', state: 'stopped' },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});

describe('finding systemctl', () => {
  test('is the first candidate that exists', async () => {
    const found = await findSystemctl((path) => Promise.resolve(path === '/bin/systemctl'));

    expect(found).toBe('/bin/systemctl');
  });

  test('is undefined when none exists', async () => {
    expect(await findSystemctl(() => Promise.resolve(false))).toBeUndefined();
  });
});

describe('a Service with a health URL', () => {
  const servers: { stop: (force: boolean) => unknown }[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      void server.stop(true);
    }
  });

  const serve = (handler: () => Response | Promise<Response>) => {
    const server = Bun.serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
    servers.push(server);
    return `http://127.0.0.1:${String(server.port)}/healthz`;
  };

  test('is checked beside its supervisor, which can pass while the health check fails', async () => {
    const health = serve(() => new Response('down', { status: 503 }));

    const { outcomes } = await check({ ...WEB, health }, shown({ active: 'active' }));

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'ActiveState=active', state: 'up' },
      { check: 'health', detail: 'HTTP 503', state: 'unhealthy' },
    ]);
  });

  test('reports both checks failing, supervisor first', async () => {
    const health = serve(() => new Response('down', { status: 500 }));

    const { outcomes } = await check({ ...WEB, health }, shown({ active: 'failed' }));

    expect(outcomes.map(({ check: kind, state }) => [kind, state])).toEqual([
      ['supervisor', 'stopped'],
      ['health', 'unhealthy'],
    ]);
  });

  test('is checked while the supervisor check runs, not after it', async () => {
    const requested = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    const health = serve(async () => {
      requested.resolve();
      await asked.promise;
      return new Response('ok');
    });
    const outcomes = await checkService(
      { ...WEB, health },
      {
        httpGet,
        run: async () => {
          asked.resolve();
          await requested.promise;
          return shown({ active: 'active' });
        },
        systemctl: SYSTEMCTL,
      },
    );

    expect(outcomes.map(({ state }) => state)).toEqual(['up', 'up']);
  });

  test('is unhealthy when the URL does not answer in 5 seconds, the supervisor check unaffected', async () => {
    const asked: Parameters<HttpGet>[1][] = [];
    const timesOut: HttpGet = (_, options) => {
      asked.push(options);
      return Promise.resolve({ kind: 'failed', message: 'no answer', reason: 'timeout' });
    };

    const outcomes = await checkService(
      { ...WEB, health: 'http://127.0.0.1:8080/healthz' },
      {
        httpGet: timesOut,
        run: () => Promise.resolve(shown({ active: 'active' })),
        systemctl: SYSTEMCTL,
      },
    );

    expect(asked).toEqual([{ maxBodyBytes: 0, timeoutMs: 5000 }]);
    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'ActiveState=active', state: 'up' },
      { check: 'health', detail: 'timed out after 5 s', state: 'unhealthy' },
    ]);
  });

  test('under a supervisor not checked yet is checked by its URL, its supervisor reported unchecked', async () => {
    const health = serve(() => new Response('ok'));

    const { outcomes } = await check(
      { container: 'web', health, name: 'web', supervisor: 'docker' },
      shown({ active: 'failed' }),
    );

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'docker is not checked', state: 'unchecked' },
      { check: 'health', detail: 'HTTP 200', state: 'up' },
    ]);
  });

  test('under none has the URL as its only check, with no supervisor check', async () => {
    const health = serve(() => new Response('ok'));

    const { outcomes, ran } = await check(
      { health, name: 'web', supervisor: 'none' },
      shown({ active: 'failed' }),
    );

    expect(outcomes).toEqual([{ check: 'health', detail: 'HTTP 200', state: 'up' }]);
    expect(ran).toEqual([]);
  });

  test('under none fails as unhealthy when the URL does not answer', async () => {
    const health = serve(() => new Response('', { status: 502 }));

    const { outcomes } = await check(
      { health, name: 'web', supervisor: 'none' },
      shown({ active: 'active' }),
    );

    expect(outcomes).toEqual([{ check: 'health', detail: 'HTTP 502', state: 'unhealthy' }]);
  });
});
