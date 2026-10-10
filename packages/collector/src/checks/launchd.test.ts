import { describe, expect, test } from 'bun:test';

import type { ServiceRecord } from '@heimdall/schema';

import type { CommandResult } from '../subprocess.ts';
import { checkService } from './services.ts';

const WEB: ServiceRecord = { label: 'com.example.web', name: 'web', supervisor: 'launchd' };
const UID = 501;

// The fixtures below are hand-written from the documented shape of `launchctl
// print`: the fields of the service one tab in, nested blocks two tabs in. They
// are to be replaced with output captured on a Mac during the milestone's live
// proof.
//
// `launchctl print` for a launchd agent that is running.
const RUNNING = `gui/501/com.example.web = {
\tactive count = 1
\tpath = /Users/example/Library/LaunchAgents/com.example.web.plist
\ttype = LaunchAgent
\tstate = running

\tprogram = /usr/local/bin/web
\targuments = {
\t\t/usr/local/bin/web
\t\t--port
\t\t8080
\t}

\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}

\tenvironment = {
\t\tXPC_SERVICE_NAME => com.example.web
\t}

\tdomain = gui/501 [100001]
\tasid = 100001
\tminimum runtime = 10
\texit timeout = 5
\truns = 1
\tpid = 12345
\timmediate reason = inefficient
\tforks = 0
\texecs = 1
\tinitialized = 1
\ttrampolined = 1
\tstarted suspended = 0
\tproxy started suspended = 0
\tlast exit code = (never exited)

\tresource coalition = {
\t\tID = 2048
\t\ttype = resource
\t\tstate = active
\t\tactive count = 1
\t\tname = com.example.web
\t}

\tjetsam coalition = {
\t\tID = 2049
\t\ttype = jetsam
\t\tstate = active
\t\tactive count = 1
\t\tname = com.example.web
\t}

\tevent triggers = {
\t}

\tproperties = keepalive | runatload | inferred program
}
`;

// The same agent loaded but with no process: it exited with status 78.
const LOADED_NOT_RUNNING = `gui/501/com.example.web = {
\tactive count = 0
\tpath = /Users/example/Library/LaunchAgents/com.example.web.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /usr/local/bin/web
\tdomain = gui/501 [100001]
\tasid = 100001
\tminimum runtime = 10
\texit timeout = 5
\truns = 3
\tlast exit code = 78

\tproperties = runatload | inferred program
}
`;

// An agent that is not running whose coalition blocks, nested inside it, have a
// state and a last exit code of their own that are not the agent's.
const NESTED_FIELDS_ONLY = `gui/501/com.example.web = {
\ttype = LaunchAgent
\tstate = not running

\tresource coalition = {
\t\tID = 2048
\t\tstate = active
\t\tlast exit code = 99
\t}

\tjetsam coalition = {
\t\tID = 2049
\t\tstate = running
\t\tpid = 999
\t}

\tlast exit code = 1
}
`;

const NOT_FOUND_GUI =
  'Bad request.\nCould not find service "com.example.web" in domain for user gui: 501\n';
const NOT_FOUND_SYSTEM =
  'Bad request.\nCould not find service "com.example.web" in domain for system\n';

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
  failed(113, domain === 'gui' ? NOT_FOUND_GUI : NOT_FOUND_SYSTEM);

// Checks `record` with a fake launchctl that answers per domain target, and
// answers what the check found and the commands it ran. A target the test gives
// no answer for is not found.
const check = async (
  answers: Record<string, CommandResult | Error>,
  options: { record?: ServiceRecord; uid?: number | undefined } = {},
) => {
  const ran: string[][] = [];
  const outcomes = await checkService(options.record ?? WEB, {
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

const GUI = 'gui/501/com.example.web';
const SYSTEM = 'system/com.example.web';

describe('a launchd Service', () => {
  test('is up when its agent has a running process in the account domain', async () => {
    const { outcomes, ran } = await check({ [GUI]: printed(RUNNING) });

    expect(outcomes).toEqual([{ check: 'supervisor', detail: 'state = running', state: 'up' }]);
    expect(ran).toEqual([['/bin/launchctl', 'print', GUI]]);
  });

  test('is up when launchctl prints a pid but a state this check does not know', async () => {
    const { outcomes } = await check({
      [GUI]: printed(RUNNING.replace('state = running', 'state = xpc proxy')),
    });

    expect(outcomes).toEqual([{ check: 'supervisor', detail: 'state = xpc proxy', state: 'up' }]);
  });

  test('is stopped when its agent is loaded with no running process, with the last exit code', async () => {
    const { outcomes } = await check({ [GUI]: printed(LOADED_NOT_RUNNING) });

    expect(outcomes).toEqual([
      {
        check: 'supervisor',
        detail: 'state = not running, last exit code = 78',
        state: 'stopped',
      },
    ]);
  });

  test('is stopped without an exit code when launchctl prints none', async () => {
    const { outcomes } = await check({
      [GUI]: printed(LOADED_NOT_RUNNING.replace('\tlast exit code = 78\n', '')),
    });

    expect(outcomes).toEqual([
      { check: 'supervisor', detail: 'state = not running', state: 'stopped' },
    ]);
  });

  test("reads only the service's own fields, not those of a block inside it", async () => {
    const { outcomes } = await check({ [GUI]: printed(NESTED_FIELDS_ONLY) });

    expect(outcomes).toEqual([
      {
        check: 'supervisor',
        detail: 'state = not running, last exit code = 1',
        state: 'stopped',
      },
    ]);
  });

  test('is looked up in the system domain when the account domain does not have it, and is up there', async () => {
    const { outcomes, ran } = await check({
      [GUI]: notFoundIn('gui'),
      [SYSTEM]: printed(RUNNING.replace('gui/501/', 'system/')),
    });

    expect(outcomes).toEqual([{ check: 'supervisor', detail: 'state = running', state: 'up' }]);
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

    expect(outcomes).toEqual([{ check: 'supervisor', detail: 'not loaded', state: 'stopped' }]);
  });

  test('asks the gui domain of the account the Collector runs as', async () => {
    const { ran } = await check({}, { uid: 1000 });

    expect(ran[0]).toEqual(['/bin/launchctl', 'print', 'gui/1000/com.example.web']);
  });

  test('does not ask the system domain once the account domain answered', async () => {
    const { ran } = await check({ [GUI]: printed(LOADED_NOT_RUNNING) });

    expect(ran).toHaveLength(1);
  });

  test('is unknown when the Collector has no user id to name a gui domain with', async () => {
    const { outcomes, ran } = await check({}, { uid: undefined });

    expect(outcomes).toEqual([
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
      printed('gui/501/com.example.web = {\n\ttype = LaunchAgent\n}\n'),
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

    expect(outcomes).toEqual([
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
          '\tlast exit code = 78\n',
          '\tlast exit code = (never exited)\n\tlast terminating signal = Killed: 9\n',
        ),
      ),
    });

    expect(outcomes).toEqual([
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
      [GUI]: printed(LOADED_NOT_RUNNING.replace('\truns = 3', '\truns = 3\n\tpid = (none)')),
    });

    expect(outcomes).toMatchObject([{ state: 'stopped' }]);
  });

  test('does not count a pid that only starts with digits', async () => {
    const { outcomes } = await check({
      [GUI]: printed(LOADED_NOT_RUNNING.replace('\truns = 3', '\truns = 3\n\tpid = 12abc')),
    });

    expect(outcomes).toMatchObject([{ state: 'stopped' }]);
  });

  test('is up when its state is running even if launchctl prints no pid', async () => {
    const { outcomes } = await check({ [GUI]: printed(RUNNING.replace('\tpid = 12345\n', '')) });

    expect(outcomes).toEqual([{ check: 'supervisor', detail: 'state = running', state: 'up' }]);
  });

  test('takes root as an account like any other, asking gui/0', async () => {
    const { ran } = await check({}, { uid: 0 });

    expect(ran[0]).toEqual(['/bin/launchctl', 'print', 'gui/0/com.example.web']);
  });

  test.each([
    ['on stdout alone', { ...failed(113, ''), stdout: NOT_FOUND_GUI }],
    ['in capitals', failed(113, NOT_FOUND_GUI.toUpperCase())],
  ])(
    'is not loaded when launchctl says it could not find the service %s',
    async (_name, answer) => {
      const { outcomes } = await check({ [GUI]: answer, [SYSTEM]: answer });

      expect(outcomes).toEqual([{ check: 'supervisor', detail: 'not loaded', state: 'stopped' }]);
    },
  );

  test.each([
    ['exits 1 with the not found message', failed(1, NOT_FOUND_GUI)],
    ['exits 113 about a domain', failed(113, 'Could not find domain for user gui: 501\n')],
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

  test('cuts a long detail to what the Hub takes', async () => {
    const { outcomes } = await check({
      [GUI]: printed(
        LOADED_NOT_RUNNING.replace('state = not running', `state = ${'x'.repeat(500)}`),
      ),
    });

    expect(outcomes[0]?.detail.length).toBeLessThanOrEqual(200);
  });
});
