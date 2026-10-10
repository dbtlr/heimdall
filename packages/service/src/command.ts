import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';

import { Command, escapeControlCharacters } from '@loomcli/core';
import type { StandardSchemaV1 } from '@loomcli/core';
import { configInput } from '@loomcli/plugins/config/extension';
import { integer } from '@loomcli/validators';

import { runsCompiled } from './compiled.ts';
import { httpGet } from './http-get.ts';
import type { HttpGet } from './http-get.ts';
import { displayPath, homeOf, serviceDefinition, servicePaths } from './names.ts';
import { platformSupervisor, supported } from './platform.ts';
import { createSpawnRunner } from './runner.ts';
import { setPort } from './settings.ts';
import {
  healthUrl,
  healthWords,
  probeHealth,
  queueWords,
  spoolWords,
  renderStatus,
  systemWords,
} from './status.ts';
import { UnitNotInstalledError } from './supervisor.ts';
import type { Supervisor, UnitStatus } from './supervisor.ts';

type Env = Readonly<Record<string, string | undefined>>;

// What differs between the two binaries' `service` commands. The Collector's
// status names its paired System and counts its queue and spool, which only the
// Collector knows how to read.
export type ServiceSpec =
  | { binary: 'hub'; version: string }
  | {
      binary: 'collector';
      defaultStateDir: (place: { env: Env; home: string; platform: NodeJS.Platform }) => string;
      // The System the identity under `stateDir` names and the origin of the Hub
      // it paired with, or undefined when it has none. It rejects, with a
      // message that holds no secret, for an identity it cannot read.
      pairedSystem: (stateDir: string) => Promise<{ hub: string; system: string } | undefined>;
      // The samples waiting in the queue under `stateDir`, or undefined when there is no queue yet.
      queueDepth: (stateDir: string) => Promise<number | undefined>;
      // The transcript spool under `stateDir`: its stored bytes and when its oldest
      // content was spooled (epoch ms, null when empty), or undefined when there is no spool yet.
      spool: (stateDir: string) => Promise<{ bytes: number; oldestAt: number | null } | undefined>;
      version: string;
    };

// What the commands reach outside the process. Tests replace any of it.
export type ServiceEnvironment = {
  compiled: () => boolean;
  executable: string;
  httpGet: HttpGet;
  // The clock, in epoch milliseconds.
  now: () => number;
  platform: NodeJS.Platform;
  // The backend for `platform`, which is a supported one.
  supervisor: (place: { home: string; label: string; platform: NodeJS.Platform }) => Supervisor;
};

const defaultEnvironment = (): ServiceEnvironment => ({
  compiled: runsCompiled,
  executable: process.execPath,
  httpGet,
  now: () => Date.now(),
  platform: process.platform,
  supervisor: (place) => {
    const uid = process.getuid?.() ?? userInfo().uid;
    return platformSupervisor({
      ...place,
      runner: createSpawnRunner({ env: process.env, uid }),
      uid,
    });
  },
});

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Accepts a setting as given, so a bad value reaches `status`, which reports it
// instead of failing: Fleet aborts on any exit code but 0.
const asGiven: StandardSchemaV1<unknown, unknown> = {
  '~standard': { validate: (value) => ({ value }), vendor: '@heimdall/service', version: 1 },
};

const portOf = (value: unknown) => {
  const port = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
};

// The origin of a configured Hub URL, or undefined when it is not one.
const originOf = (value: unknown) => {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return undefined;
  }
  const { origin } = new URL(value);
  return origin === 'null' ? undefined : origin;
};

// The parts of a Loom action context the commands use.
type Context = {
  host: { env: Env };
  out: { fatal: (message: string) => never; print: (message: string) => Promise<void> };
  style: { escape: (text: string) => string };
};

// Plain text out, with control characters and markup in paths shown literally.
// Each line is escaped alone, so the line breaks between them stay.
const io = ({ host, out, style }: Context) => {
  const clean = (text: string) =>
    text
      .split('\n')
      .map((line) => style.escape(escapeControlCharacters(line)))
      .join('\n');
  return {
    env: host.env,
    fail: (message: string) => out.fatal(clean(message)),
    home: homeOf(host.env),
    print: (message: string) => out.print(clean(message)),
  };
};

// `heimdall-hub service …` or `heimdall-collector service …`: install, remove,
// drive, and report this binary's own Service (ADR-0007). `environment`
// replaces what the commands reach outside the process, for tests.
export const serviceCommand = (
  spec: ServiceSpec,
  environment: Partial<ServiceEnvironment> = {},
): Command => {
  const { binary } = spec;
  const program = `heimdall-${binary}`;
  const settings = () => ({ ...defaultEnvironment(), ...environment });

  // Every command but status needs a supervisor backend for this platform.
  const supervisorFor = (place: ReturnType<typeof io>) => {
    const env = settings();
    if (!supported(env.platform)) {
      return place.fail(
        `Service management on ${env.platform} is not supported. ${program} service works on Linux and macOS.`,
      );
    }
    const { label } = servicePaths(binary, place.home);
    return {
      env,
      label,
      supervisor: env.supervisor({ home: place.home, label, platform: env.platform }),
    };
  };

  // Install and uninstall change the real supervisor, which only a compiled
  // binary may do: a source run, such as a test, never installs a real unit.
  // The check comes before the platform's, so it holds on every platform.
  const compiledSupervisor = (place: ReturnType<typeof io>) => {
    if (!settings().compiled()) {
      return place.fail(
        `This ${program} is not a compiled binary, and only a compiled binary may install or uninstall its Service. Compile it with bun run build:${binary}, then run the compiled binary.`,
      );
    }
    return supervisorFor(place);
  };

  const install = async (context: Context, port: number | undefined) => {
    const place = io(context);
    const { env, label, supervisor } = compiledSupervisor(place);
    const paths = servicePaths(binary, place.home);
    const shown = (path: string) => displayPath(path, place.home);
    try {
      if (port !== undefined && (await setPort(paths.config, port))) {
        await place.print(`Set port = ${String(port)} in ${shown(paths.config)}.`);
      }
      await mkdir(dirname(paths.log), { recursive: true });
      const { unitWritten } = await supervisor.install(
        serviceDefinition({ binary, executable: env.executable, home: place.home }),
      );
      await place.print(
        unitWritten
          ? `Wrote ${shown(supervisor.unit)}.`
          : `${shown(supervisor.unit)} is unchanged.`,
      );
      await place.print(`Restarted ${label}; it logs to ${shown(paths.log)}.`);
    } catch (error) {
      place.fail(`Could not install ${label}: ${describeError(error)}`);
    }
  };

  const installCommand =
    binary === 'hub'
      ? new Command('install', {
          description:
            'Install the Hub as a user Service and restart it. --port first stores the port in hub.toml.',
        })
          .option('port', {
            description: 'Store this port in hub.toml, unless the file already holds it.',
            type: 'string',
            validate: integer({ max: 65_535, min: 1 }),
          })
          .action((context) => install(context, context.options.port))
      : new Command('install', {
          description: 'Install the Collector as a user Service and restart it.',
        }).action((context) => install(context, undefined));

  const uninstallCommand = new Command('uninstall', {
    description: 'Stop and remove the user Service, keeping the config file and log.',
  }).action(async (context) => {
    const place = io(context);
    const { label, supervisor } = compiledSupervisor(place);
    try {
      const { removed } = await supervisor.uninstall();
      const kept =
        binary === 'collector' ? 'config file, log, and queue stay' : 'config file and log stay';
      await place.print(
        removed
          ? `Removed ${label}: stopped it and deleted ${displayPath(supervisor.unit, place.home)}. Its ${kept}.`
          : `${label} is not installed; there is nothing to remove.`,
      );
    } catch (error) {
      place.fail(`Could not uninstall ${label}: ${describeError(error)}`);
    }
  });

  const drive = (verb: 'restart' | 'start' | 'stop', done: string, description: string) =>
    new Command(verb, { description }).action(async (context) => {
      const place = io(context);
      const { label, supervisor } = supervisorFor(place);
      try {
        await supervisor[verb]();
        await place.print(`${done} ${label}.`);
      } catch (error) {
        place.fail(
          error instanceof UnitNotInstalledError
            ? `${label} is not installed. Run ${program} service install first.`
            : `Could not ${verb} ${label}: ${describeError(error)}`,
        );
      }
    });

  // The unit as the supervisor sees it; a failure to ask is part of the answer.
  const unitStatus = async (
    place: ReturnType<typeof io>,
    label: string,
  ): Promise<UnitStatus | Omit<UnitStatus, 'unit'>> => {
    const env = settings();
    if (!supported(env.platform)) {
      return {
        installed: false,
        notes: [],
        running: false,
        stateKnown: true,
        summary: `service management on ${env.platform} is not supported`,
      };
    }
    try {
      return await env.supervisor({ home: place.home, label, platform: env.platform }).status();
    } catch (error) {
      return {
        installed: false,
        notes: [],
        running: false,
        stateKnown: false,
        summary: `state unknown (${describeError(error)})`,
      };
    }
  };

  // Asked of a running unit, and of one whose state is unknown, which may be running.
  const hubHealth = async (
    unit: { running: boolean; stateKnown: boolean },
    { host, port: portSetting }: { host?: unknown; port?: unknown },
  ) => {
    if (!unit.running && unit.stateKnown) {
      return [];
    }
    const port = portOf(portSetting);
    if (port === undefined) {
      return [
        ['health', `unknown (the port setting ${String(portSetting)} is not a port)`] as const,
      ];
    }
    const url = healthUrl(host, port);
    const answer = await probeHealth({ get: settings().httpGet, url });
    return [['health', healthWords(answer, spec.version, url)] as const];
  };

  // The Collector's `system`, `queue`, and `spool` lines, read from the state directory `run` uses.
  const collectorDetails = async (
    place: ReturnType<typeof io>,
    { hub, stateDir: stateDirSetting }: { hub?: unknown; stateDir?: unknown },
  ) => {
    if (spec.binary !== 'collector') {
      return [];
    }
    const stateDir =
      typeof stateDirSetting === 'string' && stateDirSetting !== ''
        ? stateDirSetting
        : spec.defaultStateDir({ env: place.env, home: place.home, platform: settings().platform });
    const configured = originOf(hub);
    const system = await spec.pairedSystem(stateDir).then(
      (paired) => systemWords({ configured, paired }, program),
      (error: unknown) => systemWords({ problem: describeError(error) }, program),
    );
    const queue = await spec.queueDepth(stateDir).then(
      (samples) => queueWords({ samples }),
      (error: unknown) => queueWords({ problem: describeError(error) }),
    );
    const spool = await spec.spool(stateDir).then(
      (summary) => spoolWords({ now: settings().now(), summary }),
      (error: unknown) => spoolWords({ problem: describeError(error) }),
    );
    return [['system', system] as const, ['queue', queue] as const, ['spool', spool] as const];
  };

  // Status always exits 0, whatever it finds: Fleet prints the text verbatim and
  // aborts on any other code.
  const status = async (
    context: Context,
    setting: { host?: unknown; hub?: unknown; port?: unknown; stateDir?: unknown },
  ) => {
    const place = io(context);
    const paths = servicePaths(binary, place.home);
    try {
      const unit = await unitStatus(place, paths.label);
      const details =
        binary === 'hub' ? await hubHealth(unit, setting) : await collectorDetails(place, setting);
      await place.print(
        renderStatus({
          details,
          home: place.home,
          label: paths.label,
          notes: unit.notes,
          paths: {
            config: paths.config,
            log: paths.log,
            ...('unit' in unit ? { unit: unit.unit } : {}),
          },
          summary: unit.summary,
        }),
      );
    } catch (error) {
      await place.print(`${paths.label}: status unknown (${describeError(error)})`);
    }
  };

  const statusDescription = 'Print the unit state, paths, and health. Always exits 0.';
  // Status reads the settings `serve` and `run` read, from the same flag,
  // variable, and file key, so it asks the running binary where it listens.
  const statusCommand =
    binary === 'hub'
      ? new Command('status', { description: statusDescription })
          .option('host', {
            env: 'HEIMDALL_HOST',
            extensions: [configInput({ path: 'host' })],
            hidden: true,
            type: 'string',
            validate: asGiven,
          })
          .option('port', {
            default: '8080',
            env: 'HEIMDALL_PORT',
            extensions: [configInput({ path: 'port' })],
            hidden: true,
            type: 'string',
            validate: asGiven,
          })
          .action((context) =>
            status(context, { host: context.options.host, port: context.options.port }),
          )
      : new Command('status', { description: statusDescription })
          .option('hub', {
            env: 'HEIMDALL_HUB',
            extensions: [configInput({ path: 'hub' })],
            hidden: true,
            type: 'string',
            validate: asGiven,
          })
          .option('state-dir', {
            env: 'HEIMDALL_STATE_DIR',
            extensions: [configInput({ path: 'stateDir' })],
            hidden: true,
            type: 'string',
            validate: asGiven,
          })
          .action((context) =>
            status(context, {
              hub: context.options.hub,
              stateDir: context.options['state-dir'],
            }),
          );

  return new Command('service', {
    description: `Install, run, and report ${program} as a user Service.`,
  })
    .command(installCommand)
    .command(uninstallCommand)
    .command(drive('start', 'Started', 'Start the installed user Service.'))
    .command(drive('stop', 'Stopped', 'Stop the installed user Service until the next start.'))
    .command(drive('restart', 'Restarted', 'Restart the installed user Service.'))
    .command(statusCommand);
};
