import { SOURCE_NAME, SYSTEM_NAME } from '@heimdall/schema';
import { serviceCommand } from '@heimdall/service';
import { Application, Command, override, plugin } from '@loomcli/core';
import { config } from '@loomcli/plugins/config';
import { configInput } from '@loomcli/plugins/config/extension';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';
import { versionLine as loomVersionLine } from '@loomcli/plugins/version/views';
import { date, integer, text, url } from '@loomcli/validators';

import { pairAction, unpairAction } from './pair-commands.ts';
import { serveAction } from './serve.ts';
import { deleteTranscriptsAction } from './transcript-commands.ts';
import { HUB_VERSION, versionLine } from './version.ts';

// SIGTERM from systemd and SIGINT from a terminal cancel `serve`, which stops
// listening and closes its database connections.
const signals = () => plugin('@heimdall/hub/signals', { signals: ['SIGINT', 'SIGTERM'] });

// The database every command opens, from its flag, then its variable, then
// `[database] url` in the configuration file, where Fleet's secret path reaches it.
const database = {
  description: 'PostgreSQL connection URL.',
  env: 'HEIMDALL_DATABASE_URL',
  extensions: [configInput({ path: 'database.url' })],
  required: true,
  type: 'string',
  validate: url({ protocols: ['postgres', 'postgresql'] }),
} as const;

// Each `serve` setting comes from its flag, then its variable, then the
// configuration file.
export const serve = new Command('serve', {
  description: 'Accept Reports from Collectors and serve the page of Systems.',
})
  .option('database', database)
  .option('host', {
    default: '127.0.0.1',
    description: 'Address to listen on.',
    env: 'HEIMDALL_HOST',
    extensions: [configInput({ path: 'host' })],
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  .option('port', {
    default: '8080',
    description: 'TCP port to listen on; 0 picks a free one.',
    env: 'HEIMDALL_PORT',
    extensions: [configInput({ path: 'port' })],
    type: 'string',
    validate: integer({ max: 65_535, min: 0 }),
  })
  .action(serveAction);

// The System a `pair` or `unpair` names, by Fleet's System name rule.
const system = {
  description: 'The Fleet System name, such as laptop-1.',
  required: true,
  validate: text({ message: 'Use a Fleet System name, such as laptop-1.', pattern: SYSTEM_NAME }),
} as const;

export const pair = new Command('pair', {
  description:
    'Issue a Pairing code for a System. On that System, heimdall-collector pair <code> redeems it.',
})
  .argument('system', system)
  .option('database', database)
  .action(pairAction);

export const unpair = new Command('unpair', {
  description: "Revoke a System's token and any pending Pairing code. Its history stays.",
})
  .argument('system', system)
  .option('database', database)
  .action(unpairAction);

export const deleteTranscripts = new Command('delete', {
  description:
    'Delete whole generations of transcripts that match every filter given. A path whose every generation is deleted is refused from then on.',
})
  .option('system', {
    description: 'Only the transcripts of this System.',
    type: 'string',
    validate: text({ message: 'Use a Fleet System name, such as laptop-1.', pattern: SYSTEM_NAME }),
  })
  .option('source', {
    description: 'Only the transcripts of this source, such as claude-code, on any System.',
    type: 'string',
    validate: text({ message: 'Use a source name, such as claude-code.', pattern: SOURCE_NAME }),
  })
  .option('before', {
    description:
      'Only generations last uploaded before the start of this day in UTC, such as 2026-01-01.',
    type: 'string',
    validate: date(),
  })
  .option('dry-run', {
    description: 'Say what would be deleted, and delete nothing.',
    type: 'boolean',
  })
  .option('database', database)
  .action(deleteTranscriptsAction);

const transcripts = new Command('transcripts', {
  description: 'Manage the archive of agent Session transcripts.',
}).command(deleteTranscripts);

// The `heimdall-hub` command line. `main.ts` runs it against the process.
export const app = new Application('heimdall-hub', {
  description: 'Store Reports from every System and serve the dashboard.',
  plugins: [help(), version(), config({ file: '.config/heimdall/hub.{toml,json}' }), signals()],
  version: HUB_VERSION,
  // Loom's line (`<name> v<version>`) has no room for the Report schema version yet;
  // HMD-13 swaps this override for Loom's version postfix once LM-s22 ships.
  views: [override(loomVersionLine, { render: () => `${versionLine()}\n` })],
})
  .command(serve)
  .command(pair)
  .command(unpair)
  .command(transcripts)
  .command(serviceCommand({ binary: 'hub', version: HUB_VERSION }));
