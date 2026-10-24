import { describe, expect, test } from 'bun:test';

import type { ServiceRecord } from '@heimdall/schema';
import { httpGet } from '@heimdall/service';
import {
  NO_GUI_DOMAIN,
  NOT_FOUND_IN_GUI,
  NOT_FOUND_IN_SYSTEM,
  NOT_RUNNING_AGENT,
  RUNNING_AGENT,
  SYSTEM_DAEMON,
} from '@heimdall/service/testing';

import type { CommandResult } from '../subprocess.ts';
import { checkService } from './services.ts';

const WEB: ServiceRecord = {
  label: 'com.dbtlr.heimdall.collector',
  name: 'collector',
  supervisor: 'launchd',
};
const UID = 501;

// The fixtures are captured from macOS on 2026-10-13, environment blocks
// redacted and paths generalized: `RUNNING` is a running agent, `LOADED_NOT_RUNNING`
// a loaded agent with no process, and `DAEMON` a system daemon. A few tests
// change one line of a capture, for cases the capture does not cover.
const RUNNING = RUNNING_AGENT;
const LOADED_NOT_RUNNING = NOT_RUNNING_AGENT;
const DAEMON = SYSTEM_DAEMON;

// An agent that is not running whose coalition blocks, nested inside it, have a
// state, a pid, and a last exit code of their own that are not the agent's.
const NESTED_FIELDS_ONLY = LOADED_NOT_RUNNING.replaceAll(
  '\t\tstate = active\n',
  '\t\tstate = running\n\t\tpid = 999\n\t\tlast exit code = 99\n',
);

const printed = (stdout: string): CommandResult => ({
  exitCode: 0,
  kind: 'exited',
  stderr: '',
  stdout,
});
const failed = (exitCode: number, stderr: string): CommandResult => ({
  exitCode,
  kind: 'exited',
  stderr,
  stdout: '',
});
const TIMED_OUT: CommandResult = { kind: 'timed out' };
const notFoundIn = (domain: 'gui' | 'system') =>
  failed(113, domain === 'gui' ? NOT_FOUND_IN_GUI : NOT_FOUND_IN_SYSTEM);

// Checks `record` with a fake launchctl that answers per domain target, and
// answers what the check found and the commands it ran. A target the test gives
// no answer for is not found.
const check = async (
  answers: Record<string, CommandResult | Error>,
  options: { record?: ServiceRecord; uid?: number | undefined } = {},
) => {
  const ran: string[][] = [];
  const outcomes = await checkService(options.record ?? WEB, {
    httpGet,
    run: (cmd) => {
      ran.push([...cmd]);
      const answer = answers[cmd.at(-1) ?? ''] ?? notFoundIn('gui');
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    systemctl: undefined,
    ...('uid' in options ? { uid: options.uid } : { uid: UID }),
  });
  return { outcomes, ran };
};

const GUI = 'gui/501/com.dbtlr.heimdall.collector';
const SYSTEM = 'system/com.dbtlr.heimdall.collector';

describe('a launchd Service', () => {
  test('is up when its agent has a running process in the account domain', async () => {
    const { outcomes, ran } = await check({ [GUI]: printed(RUNNING) });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'state = running', state: 'up' },
    ]);
    expect(ran).toEqual([['/bin/launchctl', 'print', GUI]]);
  });

  test('is up when launchctl prints a pid but a state this check does not know', async () => {
    const { outcomes } = await check({
      [GUI]: printed(RUNNING.replace('state = running', 'state = xpc proxy')),
    });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'state = xpc proxy', state: 'up' },
    ]);
  });

  test('is stopped when its agent is loaded with no running process, with the last exit code', async () => {
    const { outcomes } = await check({ [GUI]: printed(LOADED_NOT_RUNNING) });

    expect(outcomes).toMatchObject([
      {
        check: 'supervisor',
        detail: 'state = not running, last exit code = 0',
        state: 'stopped',
      },
    ]);
  });

  test('is stopped without an exit code when launchctl prints none', async () => {
    const { outcomes } = await check({
      [GUI]: printed(LOADED_NOT_RUNNING.replace('\tlast exit code = 0\n', '')),
    });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'state = not running', state: 'stopped' },
    ]);
  });

  test("reads only the service's own fields, not those of a block inside it", async () => {
    const { outcomes } = await check({ [GUI]: printed(NESTED_FIELDS_ONLY) });

    expect(outcomes).toMatchObject([
      {
        check: 'supervisor',
        detail: 'state = not running, last exit code = 0',
        state: 'stopped',
      },
    ]);
  });

  test('is looked up in the system domain when the account domain does not have it, and is up there', async () => {
    const { outcomes, ran } = await check({
      [GUI]: notFoundIn('gui'),
      [SYSTEM]: printed(DAEMON),
    });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'state = running', state: 'up' },
    ]);
    expect(ran).toEqual([
      ['/bin/launchctl', 'print', GUI],
      ['/bin/launchctl', 'print', SYSTEM],
    ]);
  });

  test('is stopped when the system domain has it loaded with no running process', async () => {
    const { outcomes } = await check({
      [GUI]: notFoundIn('gui'),
      [SYSTEM]: printed(LOADED_NOT_RUNNING),
    });

    expect(outcomes).toMatchObject([{ state: 'stopped' }]);
  });

  test('is stopped when neither domain has it loaded', async () => {
    const { outcomes } = await check({ [GUI]: notFoundIn('gui'), [SYSTEM]: notFoundIn('system') });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'not loaded', state: 'stopped' },
    ]);
  });

  test('asks the gui domain of the account the Collector runs as', async () => {
    const { ran } = await check({}, { uid: 1000 });

    expect(ran[0]).toEqual(['/bin/launchctl', 'print', 'gui/1000/com.dbtlr.heimdall.collector']);
  });

  test('does not ask the system domain once the account domain answered', async () => {
    const { ran } = await check({ [GUI]: printed(LOADED_NOT_RUNNING) });

    expect(ran).toHaveLength(1);
  });

  test('is unknown when the Collector has no user id to name a gui domain with', async () => {
    const { outcomes, ran } = await check({}, { uid: undefined });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'no user id for the gui domain', state: 'unknown' },
    ]);
    expect(ran).toEqual([]);
  });

  test.each([
    ['exits non-zero for another reason', failed(1, 'launchctl: something went wrong\n')],
    ['refuses the domain', failed(125, 'Domain does not support specified action\n')],
    ['exits 113 for a reason other than a missing service', failed(113, 'Bad request.\n')],
    ['exits 0 with no service block', printed('')],
    ['exits 0 with output it does not know', printed('launchctl 9000 says hello\n')],
    [
      'prints a service block without a state',
      printed('gui/501/com.dbtlr.heimdall.collector = {\n\ttype = LaunchAgent\n}\n'),
    ],
    ['times out', TIMED_OUT],
    ['cannot run, as when launchctl is not installed', new Error('ENOENT')],
  ])('is unknown when launchctl %s', async (_name, answer) => {
    const { outcomes } = await check({ [GUI]: answer });

    expect(outcomes).toMatchObject([{ check: 'supervisor', state: 'unknown' }]);
  });

  test('is unknown, not stopped, when the system domain fails after the account domain did not have it', async () => {
    const { outcomes } = await check({
      [GUI]: notFoundIn('gui'),
      [SYSTEM]: TIMED_OUT,
    });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'launchctl timed out', state: 'unknown' },
    ]);
  });

  test('is unknown without trying the system domain when the account domain fails', async () => {
    const { outcomes, ran } = await check({
      [GUI]: failed(1, 'boom\n'),
      [SYSTEM]: printed(RUNNING),
    });

    expect(outcomes).toMatchObject([{ state: 'unknown' }]);
    expect(ran).toHaveLength(1);
  });

  test('names the signal that ended the process in the detail', async () => {
    const { outcomes } = await check({
      [GUI]: printed(
        LOADED_NOT_RUNNING.replace(
          '\tlast exit code = 0\n',
          '\tlast exit code = (never exited)\n\tlast terminating signal = Killed: 9\n',
        ),
      ),
    });

    expect(outcomes).toMatchObject([
      {
        check: 'supervisor',
        detail:
          'state = not running, last exit code = (never exited), last terminating signal = Killed: 9',
        state: 'stopped',
      },
    ]);
  });

  test('does not count a pid that is not made of digits', async () => {
    const { outcomes } = await check({
      [GUI]: printed(LOADED_NOT_RUNNING.replace('\truns = 4', '\truns = 4\n\tpid = (none)')),
    });

    expect(outcomes).toMatchObject([{ state: 'stopped' }]);
  });

  test('does not count a pid that only starts with digits', async () => {
    const { outcomes } = await check({
      [GUI]: printed(LOADED_NOT_RUNNING.replace('\truns = 4', '\truns = 4\n\tpid = 12abc')),
    });

    expect(outcomes).toMatchObject([{ state: 'stopped' }]);
  });

  test('is up when its state is running even if launchctl prints no pid', async () => {
    const { outcomes } = await check({ [GUI]: printed(RUNNING.replace('\tpid = 59099\n', '')) });

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'state = running', state: 'up' },
    ]);
  });

  test('takes root as an account like any other, asking gui/0', async () => {
    const { ran } = await check({}, { uid: 0 });

    expect(ran[0]).toEqual(['/bin/launchctl', 'print', 'gui/0/com.dbtlr.heimdall.collector']);
  });

  test.each([
    ['on stdout alone', { ...failed(113, ''), stdout: NOT_FOUND_IN_GUI }],
    ['in capitals', failed(113, NOT_FOUND_IN_GUI.toUpperCase())],
  ])(
    'is not loaded when launchctl says it could not find the service %s',
    async (_name, answer) => {
      const { outcomes } = await check({ [GUI]: answer, [SYSTEM]: answer });

      expect(outcomes).toMatchObject([
        { check: 'supervisor', detail: 'not loaded', state: 'stopped' },
      ]);
    },
  );

  test.each([
    ['exits 1 with the not found message', failed(1, NOT_FOUND_IN_GUI)],
    ['exits 113 about a domain', failed(113, NO_GUI_DOMAIN)],
    [
      'exits non-zero with output that looks like a service',
      { ...failed(1, 'oops'), stdout: LOADED_NOT_RUNNING },
    ],
    [
      'prints a state of only whitespace',
      printed(RUNNING.replace('state = running', 'state =    ')),
    ],
  ])('is unknown when launchctl %s', async (_name, answer) => {
    const { outcomes } = await check({ [GUI]: answer });

    expect(outcomes).toMatchObject([{ state: 'unknown' }]);
  });

  test('is unknown, without asking the system domain, when the account has no GUI domain', async () => {
    const noDomain = failed(112, NO_GUI_DOMAIN);

    const { outcomes, ran } = await check(
      { 'gui/4242424/com.dbtlr.heimdall.collector': noDomain, [SYSTEM]: printed(DAEMON) },
      { uid: 4_242_424 },
    );

    expect(outcomes).toMatchObject([
      { check: 'supervisor', detail: 'launchctl exited 112', state: 'unknown' },
    ]);
    expect(ran).toEqual([['/bin/launchctl', 'print', 'gui/4242424/com.dbtlr.heimdall.collector']]);
  });

  test('cuts a long detail to what the Hub takes', async () => {
    const { outcomes } = await check({
      [GUI]: printed(
        LOADED_NOT_RUNNING.replace('state = not running', `state = ${'x'.repeat(500)}`),
      ),
    });

    expect(outcomes[0]?.detail.length).toBeLessThanOrEqual(200);
  });
});

describe('the stop facts of a launchd Service', () => {
  test('are its runs, its process, and how its last run ended, while it runs', async () => {
    const { outcomes } = await check({ [GUI]: printed(RUNNING) });

    expect(outcomes[0]?.stopFacts).toEqual({
      exitStatus: 143,
      pid: 59_099,
      result: 'exit-code',
      running: true,
      runs: 4,
    });
  });

  test('are its runs and a clean last exit while it has no process', async () => {
    const { outcomes } = await check({ [GUI]: printed(LOADED_NOT_RUNNING) });

    expect(outcomes[0]?.stopFacts).toEqual({
      exitStatus: 0,
      pid: null,
      result: 'success',
      running: false,
      runs: 4,
    });
  });

  test('take a terminating signal over the exit code, with its number', async () => {
    const { outcomes } = await check({
      [GUI]: printed(
        LOADED_NOT_RUNNING.replace(
          '\tlast exit code = 0\n',
          '\tlast exit code = 0\n\tlast terminating signal = Terminated: 15\n',
        ),
      ),
    });

    expect(outcomes[0]?.stopFacts).toMatchObject({ exitStatus: 15, result: 'signal' });
  });

  test('have no last exit for a service that never exited, or an exit code the Hub cannot take', async () => {
    const never = await check({ [SYSTEM]: printed(DAEMON) });
    const huge = await check({
      [GUI]: printed(
        LOADED_NOT_RUNNING.replace('last exit code = 0', 'last exit code = 9999999999'),
      ),
    });

    expect(never.outcomes[0]?.stopFacts).toMatchObject({ exitStatus: null, result: null });
    expect(huge.outcomes[0]?.stopFacts).toMatchObject({ exitStatus: null, result: null });
  });

  test('have no exit status for a signal number the Hub cannot take', async () => {
    const { outcomes } = await check({
      [GUI]: printed(
        LOADED_NOT_RUNNING.replace(
          '\tlast exit code = 0\n',
          '\tlast terminating signal = Signal: 12345678901\n',
        ),
      ),
    });

    expect(outcomes[0]?.stopFacts).toMatchObject({ exitStatus: null, result: 'signal' });
  });

  test('are no process and no runs for a label neither domain has loaded', async () => {
    const { outcomes } = await check({});

    expect(outcomes[0]?.stopFacts).toEqual({
      exitStatus: null,
      pid: null,
      result: null,
      running: false,
      runs: 0,
    });
  });

  test('are left out when launchctl prints no runs, so the check infers no stop', async () => {
    const { outcomes } = await check({
      [GUI]: printed(LOADED_NOT_RUNNING.replace('\truns = 4\n', '')),
    });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'state = not running, last exit code = 0', state: 'stopped' },
    ]);
  });

  test('are left out when the check is unknown', async () => {
    const { outcomes } = await check({ [GUI]: TIMED_OUT });

    expect(outcomes[0]?.stopFacts).toBeUndefined();
  });
});
