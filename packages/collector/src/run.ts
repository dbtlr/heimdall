import { arch, homedir } from 'node:os';

import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import packageJson from '../package.json' with { type: 'json' };
import type { run } from './application.ts';
import { runCollector, SAMPLE_INTERVAL_MS } from './collector.ts';
import { sendReport } from './delivery.ts';
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
// until launchd, systemd, or a terminal stops it.
export const runAction: ActionHandler<typeof run> = async ({
  host,
  options,
  out,
  signal,
  style,
}) => {
  const platform =
    reportPlatform(process.platform) ??
    out.fatal(`The Collector runs on macOS and Linux, not ${process.platform}.`);
  const stateDir =
    options['state-dir'] ??
    defaultStateDir({ env: host.env, home: host.env.HOME ?? homedir(), platform });
  const clean = (message: string) => style.escape(escapeControlCharacters(message));

  const queue = await openQueue({ capacity: QUEUE_CAPACITY, stateDir });
  try {
    await out.info(
      clean(
        `Sampling ${options.system} every ${String(SAMPLE_INTERVAL_MS / 1000)} seconds for ${options.hub.href}; queue in ${stateDir}.`,
      ),
    );
    await runCollector({
      identity: {
        collector: { arch: arch(), platform, version: packageJson.version },
        system: options.system,
      },
      log: { info: (m) => out.info(clean(m)), warn: (m) => out.warn(clean(m)) },
      queue,
      sampler: createSampler(hostProbe(platform)),
      send: (report) => sendReport({ hub: options.hub, report, signal, token: options.token }),
      signal,
    });
  } finally {
    queue.close();
  }
};
