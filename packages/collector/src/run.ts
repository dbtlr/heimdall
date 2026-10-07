import { arch } from 'node:os';

import { homeOf, keepLogRotated, runtimeLog, servicePaths } from '@heimdall/service';
import type { RuntimeLog } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import packageJson from '../package.json' with { type: 'json' };
import type { run } from './application.ts';
import { runCollector, SAMPLE_INTERVAL_MS } from './collector.ts';
import { sendReport } from './delivery.ts';
import { describeError } from './errors.ts';
import { readIdentity } from './identity.ts';
import type { SystemIdentity } from './identity.ts';
import { openQueue, QUEUE_CAPACITY } from './queue.ts';
import { defaultStateDir } from './state-dir.ts';
import { hostProbe } from './vitals/host.ts';
import { createSampler } from './vitals/sampler.ts';

const reportPlatform = (platform: NodeJS.Platform) => {
  if (platform === 'darwin' || platform === 'linux') {
    return platform;
  }
  return undefined;
};

const PAIR_HINT = 'run heimdall-collector pair <code>.';

// The identity `pair` stored, or a fatal line when there is none to report as
// or it is bound to another Hub than `hub`.
// An identity that is not private to its owner still runs, with one warning
// that says everything wrong with it.
const pairedIdentity = async ({
  clean,
  hub,
  log,
  stateDir,
}: {
  clean: (message: string) => string;
  hub: URL;
  log: RuntimeLog;
  stateDir: string;
}): Promise<SystemIdentity> => {
  const read = await readIdentity(stateDir);
  switch (read.kind) {
    case 'not paired': {
      return log.fatal(`This System is not paired; ${PAIR_HINT}`);
    }
    case 'invalid': {
      return log.fatal(clean(`This System is not paired: ${read.problem}; ${PAIR_HINT}`));
    }
    case 'paired': {
      // The token belongs to the Hub that issued it, so another Hub never sees it.
      if (read.identity.hub !== hub.origin) {
        return log.fatal(
          clean(
            `This System was paired with ${read.identity.hub}, but collector.toml names ${hub.origin}; pair again with the new Hub (heimdall-collector pair <code>).`,
          ),
        );
      }
      if (read.exposures.length > 0) {
        await log.warn(clean(`The identity is not private: ${read.exposures.join('; ')}.`));
      }
      return read.identity;
    }
    default: {
      const _exhaustive: never = read;
      return _exhaustive;
    }
  }
};

// `heimdall-collector run`: samples this System and pushes Reports to the Hub,
// as the System `pair` stored, until launchd, systemd, or a terminal stops it.
// Its runtime lines, fatal ones included, start with their time. It rotates its
// supervised log before writing its first line, then about once a day.
export const runAction: ActionHandler<typeof run> = async ({
  host,
  options,
  out,
  signal,
  style,
}) => {
  const home = homeOf(host.env);
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  const log = runtimeLog({ fatal: (line) => out.fatal(line), print: (line) => out.print(line) });
  const stopRotating = await keepLogRotated({
    onError: (error) => {
      void log.warn(clean(`Could not rotate the log: ${describeError(error)}`));
    },
    path: servicePaths('collector', home).log,
  });
  try {
    const platform =
      reportPlatform(process.platform) ??
      log.fatal(`The Collector runs on macOS and Linux, not ${process.platform}.`);
    const stateDir = options['state-dir'] ?? defaultStateDir({ env: host.env, home, platform });
    const { system, token } = await pairedIdentity({ clean, hub: options.hub, log, stateDir });
    const queue = await openQueue({ capacity: QUEUE_CAPACITY, stateDir });
    try {
      await log.info(
        clean(
          `Sampling ${system} every ${String(SAMPLE_INTERVAL_MS / 1000)} seconds for ${options.hub.href}; queue in ${stateDir}.`,
        ),
      );
      await runCollector({
        identity: {
          collector: { arch: arch(), platform, version: packageJson.version },
          system,
        },
        log: { info: (m) => log.info(clean(m)), warn: (m) => log.warn(clean(m)) },
        queue,
        sampler: createSampler(hostProbe(platform)),
        send: (report) => sendReport({ hub: options.hub, report, signal, token }),
        signal,
      });
    } finally {
      queue.close();
    }
  } finally {
    await stopRotating();
  }
};
