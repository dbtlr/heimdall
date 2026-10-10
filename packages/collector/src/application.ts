import { serviceCommand } from '@heimdall/service';
import { Application, Command, override, plugin } from '@loomcli/core';
import { config } from '@loomcli/plugins/config';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';
import { versionLine as loomVersionLine } from '@loomcli/plugins/version/views';
import { text } from '@loomcli/validators';

import packageJson from '../package.json' with { type: 'json' };
import { readIdentity } from './identity.ts';
import { hub, sleeps, stateDir } from './options.ts';
import { pairAction } from './pair.ts';
import { countWaiting } from './queue.ts';
import { forgetCommand, recordCommand } from './record.ts';
import { runAction } from './run.ts';
import { defaultStateDir } from './state-dir.ts';
import { readSpoolSummary } from './transcripts/spool.ts';
import { versionLine } from './version.ts';

// SIGTERM from launchd or systemd and SIGINT from a terminal cancel the run, so
// `run` stops between samples with its queue closed cleanly.
const signals = () => plugin('@heimdall/collector/signals', { signals: ['SIGINT', 'SIGTERM'] });

// `run` reports as the System `pair` stored in the state directory.
export const run = new Command('run', {
  description: 'Sample this System every 15 seconds and push queued Reports to the Hub.',
})
  .option('hub', hub)
  .option('sleeps', sleeps)
  .option('state-dir', stateDir)
  .action(runAction);

export const pair = new Command('pair', {
  description:
    "Redeem a Pairing code from heimdall-hub pair and keep this System's name and token.",
})
  .argument('code', {
    description: 'The Pairing code heimdall-hub pair printed, such as 7K3M-Q9XA.',
    required: true,
    validate: text({ minLength: 1 }),
  })
  .option('hub', hub)
  .option('state-dir', stateDir)
  .action(pairAction);

// The System `service status` names, with the Hub it paired with: undefined
// when unpaired, and a rejection that names the file, never its content, when
// the identity is not valid.
const pairedSystem = async (dir: string) => {
  const read = await readIdentity(dir);
  if (read.kind === 'invalid') {
    throw new Error(read.problem);
  }
  return read.kind === 'paired'
    ? { hub: read.identity.hub, system: read.identity.system }
    : undefined;
};

// The `heimdall-collector` command line. `main.ts` runs it against the process.
export const app = new Application('heimdall-collector', {
  description: 'Sample this System and push Reports to the Hub.',
  plugins: [
    help(),
    version(),
    config({ file: '.config/heimdall/collector.{toml,json}' }),
    signals(),
  ],
  version: packageJson.version,
  // Loom's line (`<name> v<version>`) has no room for the Report schema version yet;
  // HMD-13 swaps this override for Loom's version postfix once LM-s22 ships.
  views: [override(loomVersionLine, { render: () => `${versionLine()}\n` })],
})
  .command(run)
  .command(pair)
  .command(recordCommand)
  .command(forgetCommand)
  .command(
    serviceCommand({
      binary: 'collector',
      defaultStateDir,
      pairedSystem,
      queueDepth: countWaiting,
      spool: readSpoolSummary,
      version: packageJson.version,
    }),
  );
