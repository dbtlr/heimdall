import { SYSTEM_NAME } from '@heimdall/schema';
import { serviceCommand } from '@heimdall/service';
import { Application, Command, override, plugin } from '@loomcli/core';
import { config } from '@loomcli/plugins/config';
import { configInput } from '@loomcli/plugins/config/extension';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';
import { versionLine as loomVersionLine } from '@loomcli/plugins/version/views';
import { text, url } from '@loomcli/validators';

import packageJson from '../package.json' with { type: 'json' };
import { countWaiting } from './queue.ts';
import { runAction } from './run.ts';
import { defaultStateDir } from './state-dir.ts';
import { versionLine } from './version.ts';

// SIGTERM from launchd or systemd and SIGINT from a terminal cancel the run, so
// `run` stops between samples with its queue closed cleanly.
const signals = () => plugin('@heimdall/collector/signals', { signals: ['SIGINT', 'SIGTERM'] });

// Each `run` setting comes from its flag, then its variable, then the
// configuration file, so Fleet can render one file and keep the token out of argv.
export const run = new Command('run', {
  description: 'Sample this System every 15 seconds and push queued Reports to the Hub.',
})
  .option('hub', {
    description: 'Base URL of the Hub.',
    env: 'HEIMDALL_HUB',
    extensions: [configInput({ path: 'hub' })],
    required: true,
    type: 'string',
    validate: url({ protocols: ['http', 'https'] }),
  })
  .option('system', {
    description: 'The Fleet System this Collector reports for.',
    env: 'HEIMDALL_SYSTEM',
    extensions: [configInput({ path: 'system' })],
    required: true,
    type: 'string',
    validate: text({ message: 'Use a Fleet System name, such as laptop-1.', pattern: SYSTEM_NAME }),
  })
  .option('token', {
    description: "The System's ingest token. Prefer the file or the variable to this flag.",
    env: 'HEIMDALL_TOKEN',
    extensions: [configInput({ path: 'token' })],
    required: true,
    type: 'string',
    validate: text(),
  })
  .option('state-dir', {
    description: 'Directory for the sample queue. Defaults to the per-user state directory.',
    env: 'HEIMDALL_STATE_DIR',
    extensions: [configInput({ path: 'stateDir' })],
    type: 'string',
    validate: text(),
  })
  .action(runAction);

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
  .command(
    serviceCommand({
      binary: 'collector',
      defaultStateDir,
      queueDepth: countWaiting,
      version: packageJson.version,
    }),
  );
