import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceDefinition } from './names.ts';
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
