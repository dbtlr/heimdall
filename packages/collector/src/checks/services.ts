import { access } from 'node:fs/promises';

import type { ServiceRecord } from '@heimdall/schema';
import type { HttpGet } from '@heimdall/service';

import type { CommandResult } from '../subprocess.ts';
import { checkContainer, dockerEndpoint } from './docker.ts';
import type { DockerTools } from './docker.ts';
import { checkHealth } from './health.ts';
import { launchdOutcome } from './launchd.ts';
import { clampDetail, supervisorOutcome } from './outcome.ts';
import type { ServiceOutcome } from './outcome.ts';
import type { StopFacts } from './stop-log.ts';

export type { ServiceOutcome } from './outcome.ts';

// What a check needs from the System: a way to run a command and the absolute
// path of systemctl, or undefined when this System has none, the id of the
// account the Collector runs as, which names its launchd gui domain, a way to
// GET over HTTP, and optionally where the Docker Engine is, which is the
// account's own Engine when not given.
export type ServiceTools = {
  docker?: DockerTools;
  httpGet: HttpGet;
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

// A time as `systemctl show --timestamp=us+utc` prints it, such as
// `Sat 2026-10-24 02:30:12.473979 UTC`, in epoch milliseconds, or null for the
// empty value of a time systemd does not hold. The weekday is not read, so its
// language does not matter. Undefined for a value of any other shape.
const unitTime = (value: string): number | null | undefined => {
  if (value === '') {
    return null;
  }
  const match = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})? UTC$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const parsed = Date.parse(`${match[1] ?? ''}T${match[2] ?? ''}${(match[3] ?? '').slice(0, 4)}Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const MAX_RESULT_LENGTH = 64;

// What systemd holds about a unit that the stop log compares (ADR-0021), or
// undefined when its answer lacks a time or holds one the Collector cannot
// read, so a check infers nothing from it. A systemd that predates NRestarts
// counts no restarts.
const unitStopFacts = (shown: Map<string, string>): StopFacts | undefined => {
  const startedAt = unitTime(shown.get('ActiveEnterTimestamp') ?? 'missing');
  const stoppedAt = unitTime(shown.get('ActiveExitTimestamp') ?? 'missing');
  const restarts = Number(shown.get('NRestarts') ?? '0');
  if (startedAt === undefined || stoppedAt === undefined || !Number.isSafeInteger(restarts)) {
    return undefined;
  }
  const status = shown.get('ExecMainStatus') ?? '';
  const result = clampDetail(shown.get('Result') ?? '').slice(0, MAX_RESULT_LENGTH);
  return {
    exitStatus: /^-?\d{1,9}$/u.test(status) ? Number(status) : null,
    restarts: Math.max(0, restarts),
    result: result === '' ? null : result,
    running: shown.get('ActiveState') === 'active',
    startedAt,
    stoppedAt,
  };
};

// The state a unit's properties put it in. systemd answers a unit it does not
// know with LoadState=not-found, so that is a Service that is not running. Any
// ActiveState but `active` is not running, including `activating`, which a unit
// that keeps failing and restarting shows between attempts. An answer for no
// unit or for several is unknown, since it is not about the one unit recorded.
// A known state carries the unit's stop facts when they can be read.
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
  const outcome =
    load === 'not-found'
      ? supervisorOutcome('stopped', 'LoadState=not-found')
      : supervisorOutcome(active === 'active' ? 'up' : 'stopped', `ActiveState=${active}`);
  const stopFacts = unitStopFacts(shown);
  return stopFacts === undefined ? outcome : { ...outcome, stopFacts };
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

// What the Collector asks systemd about a unit: its state, and the facts the
// stop log compares (ADR-0021).
const SYSTEMD_PROPERTIES = [
  'ActiveState',
  'SubState',
  'LoadState',
  'NRestarts',
  'ActiveEnterTimestamp',
  'ActiveExitTimestamp',
  'Result',
  'ExecMainStatus',
].join(',');

// Asks systemd, the system manager or the account's user manager, whether a
// unit is running, and what it holds about the unit's stops. The unit follows `--` so a name that starts with a dash is
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
      '--timestamp=us+utc',
      `--property=${SYSTEMD_PROPERTIES}`,
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

// Asks the Docker Engine whether a container is running.
const dockerOutcome = async (container: string, { docker, httpGet }: ServiceTools) => {
  const { detail, state } = await checkContainer(container, {
    ...(docker ?? { endpoint: dockerEndpoint() }),
    get: httpGet,
  });
  return supervisorOutcome(state, detail);
};

// The supervisor check of a Service, by the supervisor that runs it.
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
    case 'docker': {
      return dockerOutcome(record.container, tools);
    }
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
): Promise<ServiceOutcome[]> => {
  const health =
    record.health === undefined ? undefined : checkHealth(record.health, { get: tools.httpGet });
  if (health !== undefined && record.supervisor === 'none') {
    return [await health];
  }
  const [supervisor, healthOutcome] = await Promise.all([supervisorCheck(record, tools), health]);
  return healthOutcome === undefined ? [supervisor] : [supervisor, healthOutcome];
};
