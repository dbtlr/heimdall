import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NO_GUI_DOMAIN, NOT_FOUND_IN_GUI, RUNNING_AGENT } from './launchctl-captures.ts';
import type { ServiceDefinition } from './names.ts';
import type { CommandResult } from './runner.ts';
import { UnitNotInstalledError } from './supervisor.ts';
import type { Supervisor, UnitStatus } from './supervisor.ts';

export * from './launchctl-captures.ts';

// A fresh directory to stand in for home, removed when disposed:
// `await using home = await tempHome()`.
export const tempHome = async () => {
  const path = await mkdtemp(join(tmpdir(), 'heimdall-home-'));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { force: true, recursive: true }),
  };
};

// A supervisor that only records what it was asked, for command tests. It
// holds one unit in memory: `install` loads it and starts it running.
export const fakeSupervisor = ({
  installed = false,
  notes = [],
  running = installed,
  unit = '/home/operator/.config/systemd/user/fake.service',
}: {
  installed?: boolean;
  notes?: string[];
  running?: boolean;
  unit?: string;
} = {}) => {
  const state = { definition: undefined as ServiceDefinition | undefined, installed, running };
  const calls: string[] = [];
  const requireUnit = (verb: string, nowRunning: boolean) => () => {
    calls.push(verb);
    if (!state.installed) {
      return Promise.reject(new UnitNotInstalledError('fake'));
    }
    state.running = nowRunning;
    return Promise.resolve();
  };
  const supervisor: Supervisor = {
    install: (definition) => {
      calls.push('install');
      const unitWritten = JSON.stringify(definition) !== JSON.stringify(state.definition);
      Object.assign(state, { definition, installed: true, running: true });
      return Promise.resolve({ unitWritten });
    },
    restart: requireUnit('restart', true),
    start: requireUnit('start', true),
    status: (): Promise<UnitStatus> => {
      calls.push('status');
      return Promise.resolve({
        installed: state.installed,
        notes,
        running: state.installed && state.running,
        stateKnown: true,
        summary: state.installed
          ? `loaded, ${state.running ? 'running (pid 4182)' : 'stopped'}`
          : 'not installed',
        unit,
      });
    },
    stop: requireUnit('stop', false),
    uninstall: () => {
      calls.push('uninstall');
      const removed = state.installed;
      Object.assign(state, { installed: false, running: false });
      return Promise.resolve({ removed });
    },
    unit,
  };
  return { calls, state, supervisor };
};

// A clock whose `sleep` only moves `now` forward, so waits cost no real time.
export const fakeClock = (start = 0) => {
  let time = start;
  return {
    now: () => time,
    sleep: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
  };
};

const launchctlOk = (stdout = ''): CommandResult => ({ code: 0, stderr: '', stdout });

// `launchctl print gui/501/<label>` for a loaded agent: the captured output of
// a running agent, with the label, state, and pid swapped in. Without a pid, the
// agent has no process.
export const launchctlPrint = (label: string, state: string, pid?: number): CommandResult =>
  launchctlOk(
    RUNNING_AGENT.replaceAll('com.dbtlr.heimdall.collector', label)
      .replace('\tstate = running\n', `\tstate = ${state}\n`)
      .replace(/\tpid = \d+\n/u, pid === undefined ? '' : `\tpid = ${String(pid)}\n`),
  );

// What launchctl answers about a service the GUI domain does not have.
export const launchctlNotFound = (label: string): CommandResult => ({
  code: 113,
  stderr: NOT_FOUND_IN_GUI.replace('com.example.heimdall.nonexistent', label),
  stdout: '',
});

// What launchctl answers about anything in a GUI domain that does not exist,
// as when the user has no GUI login session: it names the domain, not a service.
export const launchctlNoDomain = (): CommandResult => ({
  code: 112,
  stderr: NO_GUI_DOMAIN.replace('4242424', '501'),
  stdout: '',
});

// A launchd for one user's GUI domain that records each `launchctl` command
// and answers as launchd would: `bootstrap` loads the agent and `bootout`
// unloads it, `lingerPrints` prints later. `answers` scripts the next results
// of a verb, such as `bootstrap`, ahead of that behavior; a scripted bootout
// that succeeds or reports 36 (in progress) still unloads. Nothing reaches a
// real launchd.
export const fakeLaunchd = ({
  answers = {},
  domain = true,
  label = 'com.dbtlr.heimdall.collector',
  lingerPrints = 0,
  loaded = false,
}: {
  answers?: Partial<Record<string, CommandResult[]>>;
  domain?: boolean;
  label?: string;
  lingerPrints?: number;
  loaded?: boolean;
} = {}) => {
  const state = { lingering: 0, loaded };
  // Without the GUI domain, launchctl names the domain, not the service.
  const notLoaded = () => (domain ? launchctlNotFound(label) : launchctlNoDomain());
  const calls: string[] = [];
  const scripted = (verb: string) => answers[verb]?.shift();
  const answer = (argv: readonly string[]): CommandResult => {
    const [, verb = '', target = ''] = argv;
    if (verb === 'print' && target === 'gui/501') {
      return (
        scripted('print-domain') ?? (domain ? launchctlOk('gui/501 = {\n}\n') : launchctlNoDomain())
      );
    }
    if (verb === 'print') {
      if (state.lingering > 0) {
        state.lingering -= 1;
        return launchctlPrint(label, 'running', 4182);
      }
      return (
        scripted('print') ?? (state.loaded ? launchctlPrint(label, 'running', 4182) : notLoaded())
      );
    }
    if (verb === 'bootout') {
      const result =
        scripted('bootout') ?? (state.loaded ? launchctlOk() : launchctlNotFound(label));
      if (state.loaded && (result.code === 0 || result.code === 36)) {
        Object.assign(state, { lingering: lingerPrints, loaded: false });
      }
      return result;
    }
    const result = scripted(verb) ?? launchctlOk();
    if (verb === 'bootstrap' && result.code === 0) {
      state.loaded = true;
    }
    return result;
  };
  const runner = (argv: readonly string[]) => {
    calls.push(argv.join(' '));
    return Promise.resolve(answer(argv));
  };
  return { calls, runner, state };
};

// Runs `script`, the body of an ES module, in a Bun child process whose
// environment names `proxy` in `variable` (`HTTP_PROXY` or `http_proxy`), and
// answers what it printed. A test cannot set the variable in its own process:
// once the environment has named a proxy, Bun's `fetch` keeps using it, even
// after the variable is deleted, which would break every later request in the
// test run.
export const runWithProxy = async ({
  proxy,
  script,
  variable,
}: {
  proxy: string;
  script: string;
  variable: 'HTTP_PROXY' | 'http_proxy';
}): Promise<string> => {
  const child = Bun.spawn({
    cmd: [process.execPath, '--eval', script],
    env: { ...process.env, [variable]: proxy },
    stderr: 'inherit',
    stdout: 'pipe',
  });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout;
};
