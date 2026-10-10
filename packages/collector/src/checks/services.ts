import { access } from 'node:fs/promises';

import type { ServiceRecord } from '@heimdall/schema';

import type { CommandResult } from '../subprocess.ts';
import { checkHealth } from './health.ts';
import { launchdOutcome } from './launchd.ts';
import { supervisorOutcome } from './outcome.ts';
import type { ServiceOutcome } from './outcome.ts';

export type { ServiceOutcome } from './outcome.ts';

// What a check needs from the System: a way to run a command and the absolute
// path of systemctl, or undefined when this System has none, and the id of the
// account the Collector runs as, which names its launchd gui domain.
export type ServiceTools = {
  run: (cmd: readonly string[]) => Promise<CommandResult>;
  systemctl: string | undefined;
  uid?: number | undefined;
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

// What `systemctl show` printed, as the properties of each unit it answered
// for. systemctl separates units with a blank line, and treats a name as a
// pattern, so it answers for several units, or for none, when the name has a
// wildcard.
const unitBlocks = (stdout: string) =>
  stdout
    .split(/\n\s*\n/u)
    .filter((block) => block.trim() !== '')
    .map(
      (block) =>
        new Map(
          block.split('\n').flatMap((line) => {
            const at = line.indexOf('=');
            return at === -1 ? [] : [[line.slice(0, at), line.slice(at + 1)] as const];
          }),
        ),
    );

// The state a unit's properties put it in. systemd answers a unit it does not
// know with LoadState=not-found, so that is a Service that is not running. Any
// ActiveState but `active` is not running, including `activating`, which a unit
// that keeps failing and restarting shows between attempts. An answer for no
// unit or for several is unknown, since it is not about the one unit recorded.
const unitOutcome = (stdout: string): ServiceOutcome => {
  const blocks = unitBlocks(stdout);
  const [shown, ...others] = blocks;
  if (shown === undefined) {
    return supervisorOutcome('unknown', 'systemctl answered for no unit');
  }
  if (others.length > 0) {
    return supervisorOutcome('unknown', 'systemctl answered for more than one unit');
  }
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

// What systemctl prints when it cannot reach the manager's bus. Only these
// phrases count: a unit named like `dbus@.service` is echoed in other errors.
const BUS_FAILURE = /Failed to connect to (?:[a-z]+ scope )?bus|Failed to get D-Bus connection/iu;

// Why systemctl failed to answer, from what it printed. A failure that names no
// unit state is the manager being out of reach, not the unit being down.
const unreachable = (stderr: string, exitCode: number): ServiceOutcome => {
  if (BUS_FAILURE.test(stderr)) {
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
// docker join here as they are built.
const supervisorCheck = (record: ServiceRecord, tools: ServiceTools): Promise<ServiceOutcome> => {
  switch (record.supervisor) {
    case 'systemd': {
      return systemdOutcome(tools, { scope: 'system', unit: record.unit });
    }
    case 'systemd-user': {
      return systemdOutcome(tools, { scope: 'user', unit: record.unit });
    }
    case 'launchd': {
      return launchdOutcome(tools, record.label);
    }
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

// Every check of one Service: the supervisor check, and the health URL check
// beside it when the record has a health URL, run together. A `none` Service
// has no supervisor to ask, so its health URL is its only check; with no health
// URL it is reported unchecked.
export const checkService = async (
  record: ServiceRecord,
  tools: ServiceTools,
  { healthTimeoutMs }: { healthTimeoutMs?: number | undefined } = {},
): Promise<ServiceOutcome[]> => {
  const health =
    record.health === undefined
      ? undefined
      : checkHealth(record.health, { timeoutMs: healthTimeoutMs });
  if (health !== undefined && record.supervisor === 'none') {
    return [await health];
  }
  const [supervisor, healthOutcome] = await Promise.all([supervisorCheck(record, tools), health]);
  return healthOutcome === undefined ? [supervisor] : [supervisor, healthOutcome];
};
