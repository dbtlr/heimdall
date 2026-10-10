import { describe, expect, test } from 'bun:test';

import type { ServiceRecord } from '@heimdall/schema';

import type { CommandResult } from '../subprocess.ts';
import { checkService } from './services.ts';

const WEB: ServiceRecord = { label: 'com.example.web', name: 'web', supervisor: 'launchd' };
const UID = 501;

// `launchctl print` for a launchd agent that is running, as macOS prints it:
// the fields of the service one tab in, nested blocks two tabs in.
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

// An agent that holds a process in a nested block's `state` but not in its own.
const NESTED_STATE_ONLY = `gui/501/com.example.web = {
\ttype = LaunchAgent
\tstate = not running

\tendpoints = {
\t\t"com.example.web.sock" = {
\t\t\tport = 0x1f03
\t\t\tactive = 1
\t\t\tstate = running
\t\t\tpid = 999
\t\t}
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

    expect(outcomes).toEqual([{ check: 'supervisor', detail: 'pid = 12345', state: 'up' }]);
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

  test('reads only the service own fields, not those of a block inside it', async () => {
    const { outcomes } = await check({ [GUI]: printed(NESTED_STATE_ONLY) });

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

  test('cuts a long detail to what the Hub takes', async () => {
    const { outcomes } = await check({
      [GUI]: printed(
        LOADED_NOT_RUNNING.replace('state = not running', `state = ${'x'.repeat(500)}`),
      ),
    });

    expect(outcomes[0]?.detail.length).toBeLessThanOrEqual(200);
  });
});
