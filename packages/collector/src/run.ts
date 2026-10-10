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
import { createRecordsReporter } from './records-report.ts';
import { openRecords } from './records.ts';
import { resolveStateDir } from './state-dir.ts';
import { createCapture } from './transcripts/capture.ts';
import { configHome, readSessionsSection } from './transcripts/config-file.ts';
import { transcriptHub } from './transcripts/hub-client.ts';
import { startCapture } from './transcripts/loop.ts';
import { findSharedDirectory, parseSources } from './transcripts/sources.ts';
import type { Source } from './transcripts/sources.ts';
import { openSpool } from './transcripts/spool.ts';
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

// The startup line about transcript capture.
const captureLine = (sources: readonly Source[]) =>
  sources.length === 0
    ? 'Transcript capture is off; collector.toml lists no sessions.sources.'
    : `Capturing transcripts from ${sources.map((s) => `${s.name} (${s.dir})`).join(', ')}.`;

// `heimdall-collector run`: samples this System and pushes Reports to the Hub,
// as the System `pair` stored, until launchd, systemd, or a terminal stops it.
// Beside the samples it uploads the transcripts of the sources collector.toml
// lists, and drains what a removed source left spooled (ADR-0013).
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
    const stateDir = resolveStateDir({ env: host.env, option: options['state-dir'], platform });
    // The config plugin's `--config` reaches every action, though `run`'s
    // declared options do not name it.
    const named =
      'config' in options && typeof options.config === 'string' ? options.config : undefined;
    const configured = parseSources(
      await readSessionsSection({ cwd: host.cwd, home: configHome(host.env), named }),
      home,
    );
    const sources =
      configured.kind === 'refused'
        ? log.fatal(clean(`collector.toml is not valid: ${configured.problem}`))
        : configured.sources;
    const shared = await findSharedDirectory(sources);
    if (shared !== undefined) {
      log.fatal(clean(`collector.toml is not valid: ${shared}`));
    }
    const { system, token } = await pairedIdentity({ clean, hub: options.hub, log, stateDir });
    const queue = await openQueue({ capacity: QUEUE_CAPACITY, stateDir });
    const spool = await openSpool({ stateDir });
    // The daemon only reads the store; `record` and `forget` write it.
    const store = await openRecords({ stateDir });
    const runtime = {
      info: (m: string) => log.info(clean(m)),
      warn: (m: string) => log.warn(clean(m)),
    };
    const capture = createCapture({
      hub: transcriptHub({ hub: options.hub, signal, token }),
      log: runtime,
      now: Date.now,
      signal,
      sources,
      spool,
    });
    const stopCapture = startCapture({ capture, log: runtime, now: Date.now, signal });
    try {
      await log.info(
        clean(
          `Sampling ${system} every ${String(SAMPLE_INTERVAL_MS / 1000)} seconds for ${options.hub.href}; queue in ${stateDir}.`,
        ),
      );
      await log.info(clean(captureLine(sources)));
      await runCollector({
        identity: {
          collector: { arch: arch(), platform, version: packageJson.version },
          system,
        },
        log: runtime,
        queue,
        records: createRecordsReporter({ log: runtime, now: Date.now, store }),
        sampler: createSampler(hostProbe(platform)),
        send: (report) => sendReport({ hub: options.hub, report, signal, token }),
        signal,
        transcripts: capture.section,
      });
    } finally {
      await stopCapture();
      spool.close();
      store.close();
      queue.close();
    }
  } finally {
    await stopRotating();
  }
};
