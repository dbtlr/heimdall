import { access } from 'node:fs/promises';

import type { ServiceCheckKind, ServiceCheckState, ServiceRecord } from '@heimdall/schema';

import type { CommandResult } from '../subprocess.ts';

// What one check of a Service found.
export type ServiceOutcome = {
  check: ServiceCheckKind;
  detail: string;
  state: ServiceCheckState;
};

// What a check needs from the System: a way to run a command and the absolute
// path of systemctl, or undefined when this System has none.
export type ServiceTools = {
  run: (cmd: readonly string[]) => Promise<CommandResult>;
  systemctl: string | undefined;
};

// Where systemctl lives on the Linux distributions the Collector runs on. A
// launchd agent or a systemd service has a minimal PATH, so the Collector runs
// it by absolute path.
const SYSTEMCTL_CANDIDATES = ['/usr/bin/systemctl', '/bin/systemctl', '/usr/local/bin/systemctl'];

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// The first systemctl that exists, or undefined when the System has none.
export const findSystemctl = async (
  has: (path: string) => Promise<boolean> = exists,
): Promise<string | undefined> => {
  for (const candidate of SYSTEMCTL_CANDIDATES) {
    // oxlint-disable-next-line no-await-in-loop -- the first candidate that exists wins.
    if (await has(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const supervisorOutcome = (state: ServiceCheckState, detail: string): ServiceOutcome => ({
  check: 'supervisor',
  detail,
  state,
});

// What `systemctl show` printed, as the name of each property and its value.
const properties = (stdout: string) =>
  new Map(
    stdout.split('\n').flatMap((line) => {
      const at = line.indexOf('=');
      return at === -1 ? [] : [[line.slice(0, at), line.slice(at + 1)] as const];
    }),
  );

// The state a unit's properties put it in. systemd answers a unit it does not
// know with LoadState=not-found, so that is a Service that is not running. Any
// ActiveState but `active` is not running, including `activating`, which a unit
// that keeps failing and restarting shows between attempts.
const unitOutcome = (stdout: string): ServiceOutcome => {
  const shown = properties(stdout);
  const load = shown.get('LoadState');
  const active = shown.get('ActiveState');
  if (load === undefined || active === undefined || !shown.has('SubState')) {
    return supervisorOutcome('unknown', 'unexpected systemctl output');
  }
  if (load === 'not-found') {
    return supervisorOutcome('stopped', 'LoadState=not-found');
  }
  return supervisorOutcome(active === 'active' ? 'up' : 'stopped', `ActiveState=${active}`);
};

// Why systemctl failed to answer, from what it printed. A failure that names no
// unit state is the manager being out of reach, not the unit being down.
const unreachable = (stderr: string, exitCode: number): ServiceOutcome => {
  if (/bus/i.test(stderr)) {
    return supervisorOutcome('unknown', 'bus unavailable');
  }
  if (/not been booted/i.test(stderr)) {
    return supervisorOutcome('unknown', 'systemd not running');
  }
  return supervisorOutcome('unknown', `systemctl exited ${String(exitCode)}`);
};

// Asks systemd, the system manager or the account's user manager, whether a
// unit is running. The unit follows `--` so a name that starts with a dash is
// never read as an option.
const systemdOutcome = async (
  { run, systemctl }: ServiceTools,
  { scope, unit }: { scope: 'system' | 'user'; unit: string },
): Promise<ServiceOutcome> => {
  if (systemctl === undefined) {
    return supervisorOutcome('unknown', 'systemctl not found');
  }
  let result: CommandResult;
  try {
    result = await run([
      systemctl,
      ...(scope === 'user' ? ['--user'] : []),
      'show',
      '--property=ActiveState,SubState,LoadState',
      '--',
      unit,
    ]);
  } catch {
    return supervisorOutcome('unknown', 'systemctl could not run');
  }
  if (result.kind === 'timed out') {
    return supervisorOutcome('unknown', 'systemctl timed out');
  }
  return result.exitCode === 0
    ? unitOutcome(result.stdout)
    : unreachable(result.stderr, result.exitCode);
};

// The supervisor check of a Service, by the supervisor that runs it. Checks for
// launchd and docker join here as they are built.
const supervisorCheck = (record: ServiceRecord, tools: ServiceTools): Promise<ServiceOutcome> => {
  switch (record.supervisor) {
    case 'systemd': {
      return systemdOutcome(tools, { scope: 'system', unit: record.unit });
    }
    case 'systemd-user': {
      return systemdOutcome(tools, { scope: 'user', unit: record.unit });
    }
    case 'launchd':
    case 'docker':
    case 'none': {
      return Promise.resolve(supervisorOutcome('unchecked', `${record.supervisor} is not checked`));
    }
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
};

// Every check of one Service. A Service has the supervisor check now; a health
// URL check joins beside it, so one Service can fail two ways.
export const checkService = async (
  record: ServiceRecord,
  tools: ServiceTools,
): Promise<ServiceOutcome[]> => [await supervisorCheck(record, tools)];
