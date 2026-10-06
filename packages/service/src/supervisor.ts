import type { ServiceDefinition } from './names.ts';

// What `service status` reports about the unit. `summary` is in the backend's
// own words, such as `loaded, running (pid 4182)` or `not installed`.
// `stateKnown` is false when the manager could not be asked.
export type UnitStatus = {
  installed: boolean;
  notes: string[];
  running: boolean;
  stateKnown: boolean;
  summary: string;
  unit: string;
};

// One binary's unit in the user's service manager: a systemd user unit on
// Linux, and a launchd user agent on macOS once that backend exists. `install`
// converges: it rewrites the unit only when it changed, and always restarts.
export type Supervisor = {
  install: (definition: ServiceDefinition) => Promise<{ unitWritten: boolean }>;
  restart: () => Promise<void>;
  start: () => Promise<void>;
  status: () => Promise<UnitStatus>;
  stop: () => Promise<void>;
  uninstall: () => Promise<{ removed: boolean }>;
  unit: string;
};

// A manager command that failed, with what the manager said.
export class SupervisorError extends Error {
  override name = 'SupervisorError';
}

// `start`, `stop`, or `restart` asked of a unit that is not installed.
export class UnitNotInstalledError extends Error {
  override name = 'UnitNotInstalledError';
  readonly label: string;

  constructor(label: string) {
    super(`${label} is not installed.`);
    this.label = label;
  }
}
