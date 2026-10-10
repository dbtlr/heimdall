import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceDefinition } from './names.ts';
import type { CommandResult } from './runner.ts';
import { UnitNotInstalledError } from './supervisor.ts';
import type { Supervisor, UnitStatus } from './supervisor.ts';

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

// `launchctl print gui/<uid>/<label>` for a loaded agent, trimmed to the shape
// that matters: the agent's properties one tab in, nested blocks deeper.
export const launchctlPrint = (label: string, state: string, pid?: number): CommandResult =>
  launchctlOk(`gui/501/${label} = {
\tactive count = ${pid === undefined ? '0' : '1'}
\tpath = /Users/operator/Library/LaunchAgents/${label}.plist
\ttype = LaunchAgent
\tstate = ${state}

\tprogram = /opt/heimdall/bin/heimdall-collector
\targuments = {
\t\t/opt/heimdall/bin/heimdall-collector
\t\trun
\t}

\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}

\tdomain = gui/501 [100005]
\truns = 2
${pid === undefined ? '' : `\tpid = ${String(pid)}\n`}\tlast exit code = 1
\tproperties = keepalive | runatload
}
`);

// What launchctl answers about a service or domain that is not there.
export const launchctlNotFound = (target: string): CommandResult => ({
  code: 113,
  stderr: `Could not find service "${target}" in domain for user gui: 501\n`,
  stdout: '',
});

// What launchctl answers about anything in a GUI domain that does not exist,
// as when the user has no GUI login session: it names the domain, not a service.
export const launchctlNoDomain = (target: string): CommandResult => ({
  code: 113,
  stderr: `Bad request.\nCould not find domain for user gui: 501 (while printing ${target})\n`,
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
  const notLoaded = (target: string) =>
    domain ? launchctlNotFound(target) : launchctlNoDomain(target);
  const calls: string[] = [];
  const scripted = (verb: string) => answers[verb]?.shift();
  const answer = (argv: readonly string[]): CommandResult => {
    const [, verb = '', target = ''] = argv;
    if (verb === 'print' && target === 'gui/501') {
      return (
        scripted('print-domain') ??
        (domain ? launchctlOk('gui/501 = {\n}\n') : launchctlNoDomain(target))
      );
    }
    if (verb === 'print') {
      if (state.lingering > 0) {
        state.lingering -= 1;
        return launchctlPrint(label, 'running', 4182);
      }
      return (
        scripted('print') ??
        (state.loaded ? launchctlPrint(label, 'running', 4182) : notLoaded(target))
      );
    }
    if (verb === 'bootout') {
      const result =
        scripted('bootout') ?? (state.loaded ? launchctlOk() : launchctlNotFound(target));
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
