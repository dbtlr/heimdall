import { arch } from 'node:os';

import { homeOf, keepLogRotated, runtimeLog, servicePaths } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import packageJson from '../package.json' with { type: 'json' };
import type { run } from './application.ts';
import { runCollector, SAMPLE_INTERVAL_MS } from './collector.ts';
import { sendReport } from './delivery.ts';
import { describeError } from './errors.ts';
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

// `heimdall-collector run`: samples this System and pushes Reports to the Hub
// until launchd, systemd, or a terminal stops it. Its runtime lines, fatal ones
// included, start with their time. It rotates its supervised log before writing
// its first line, then about once a day.
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
    const queue = await openQueue({ capacity: QUEUE_CAPACITY, stateDir });
    try {
      await log.info(
        clean(
          `Sampling ${options.system} every ${String(SAMPLE_INTERVAL_MS / 1000)} seconds for ${options.hub.href}; queue in ${stateDir}.`,
        ),
      );
      await runCollector({
        identity: {
          collector: { arch: arch(), platform, version: packageJson.version },
          system: options.system,
        },
        log: { info: (m) => log.info(clean(m)), warn: (m) => log.warn(clean(m)) },
        queue,
        sampler: createSampler(hostProbe(platform)),
        send: (report) => sendReport({ hub: options.hub, report, signal, token: options.token }),
        signal,
      });
    } finally {
      queue.close();
    }
  } finally {
    await stopRotating();
  }
};
