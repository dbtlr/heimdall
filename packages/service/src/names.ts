import { homedir } from 'node:os';
import { join } from 'node:path';

// The two binaries that supervise themselves, by the name their files carry.
export type Binary = 'collector' | 'hub';

// What each binary's unit runs: the command, with no flags (ADR-0007).
const RUN_COMMAND: Record<Binary, string> = { collector: 'run', hub: 'serve' };

const TITLE: Record<Binary, string> = { collector: 'Collector', hub: 'Hub' };

// The files a binary's Service involves on every platform, absolute under
// `home`. The log path is the same whoever installs, so one Fleet declaration
// names it for every System. Each supervisor backend names its own unit file.
export type ServicePaths = {
  config: string;
  label: string;
  log: string;
};

export const unitLabel = (binary: Binary): string => `com.dbtlr.heimdall.${binary}`;

export const servicePaths = (binary: Binary, home: string): ServicePaths => {
  const label = unitLabel(binary);
  return {
    config: join(home, '.config', 'heimdall', `${binary}.toml`),
    label,
    log: join(home, '.local', 'state', 'heimdall', `${binary}.log`),
  };
};

// Where the systemd user manager reads a user's own unit files.
export const systemdUnitPath = (home: string, label: string): string =>
  join(home, '.config', 'systemd', 'user', `${label}.service`);

// What a supervisor runs, independent of its unit format: launchd renders the
// same definition as a property list.
export type ServiceDefinition = {
  arguments: string[];
  description: string;
  executable: string;
  label: string;
  log: string;
  workingDirectory: string;
};

export const serviceDefinition = ({
  binary,
  executable,
  home,
}: {
  binary: Binary;
  executable: string;
  home: string;
}): ServiceDefinition => {
  const { label, log } = servicePaths(binary, home);
  return {
    arguments: [RUN_COMMAND[binary]],
    description: `Heimdall ${TITLE[binary]} (${label})`,
    executable,
    label,
    log,
    workingDirectory: home,
  };
};

// `path` with `home` shown as `~`, for output an operator reads.
export const displayPath = (path: string, home: string): string =>
  path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

// Home as the binaries find it: HOME, or the account's home when HOME is unset
// or empty. Every path a Service involves lies under it.
export const homeOf = (env: Readonly<Record<string, string | undefined>>): string => {
  const home = env.HOME;
  return home === undefined || home === '' ? homedir() : home;
};
