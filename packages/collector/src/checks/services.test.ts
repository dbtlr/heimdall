import { describe, expect, test } from 'bun:test';

import type { ServiceRecord } from '@heimdall/schema';

import type { CommandResult } from '../subprocess.ts';
import { checkService, findSystemctl } from './services.ts';

const SYSTEMCTL = '/usr/bin/systemctl';

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
    run: (cmd) => {
      ran.push([...cmd]);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
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

  test('is unknown, not stopped, when the account has no user bus', async () => {
    const { outcomes } = await check(
      WEB_USER,
      failed(1, 'Failed to connect to bus: No medium found'),
    );

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
    ['launchd', { label: 'com.example.web', name: 'web', supervisor: 'launchd' }],
    ['docker', { container: 'web', name: 'web', supervisor: 'docker' }],
    ['none', { name: 'web', supervisor: 'none' }],
  ] as const)('is unchecked under %s, not down, and nothing is run', async (supervisor, record) => {
    const { outcomes, ran } = await check(record, shown({ active: 'failed' }));

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: `${supervisor} is not checked`, state: 'unchecked' },
    ]);
    expect(ran).toEqual([]);
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
