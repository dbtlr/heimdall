import { Application, Command, override, plugin } from '@loomcli/core';
import { config } from '@loomcli/plugins/config';
import { configInput } from '@loomcli/plugins/config/extension';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';
import { versionLine as loomVersionLine } from '@loomcli/plugins/version/views';
import { integer, text, url } from '@loomcli/validators';

import packageJson from '../package.json' with { type: 'json' };
import { serveAction } from './serve.ts';
import { TokenEntrySchema } from './tokens.ts';
import { versionLine } from './version.ts';

// SIGTERM from systemd and SIGINT from a terminal cancel `serve`, which stops
// listening and closes its database connections.
const signals = () => plugin('@heimdall/hub/signals', { signals: ['SIGINT', 'SIGTERM'] });

// Each `serve` setting comes from its flag, then its variable, then the
// configuration file. The token list has no variable; Fleet renders it into the
// file. The flag is for local runs and shows tokens in the process table.
export const serve = new Command('serve', {
  description: 'Accept Reports from Collectors and serve the page of Systems.',
})
  .option('database', {
    description: 'PostgreSQL connection URL.',
    env: 'HEIMDALL_DATABASE_URL',
    extensions: [configInput({ path: 'database' })],
    required: true,
    type: 'string',
    validate: url({ protocols: ['postgres', 'postgresql'] }),
  })
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
  .option('token', {
    description: "A System's ingest token as system=token, once per System. Prefer the file.",
    extensions: [configInput({ path: 'tokens' })],
    multiple: true,
    required: true,
    type: 'string',
    validate: TokenEntrySchema,
  })
  .action(serveAction);

// The `heimdall-hub` command line. `main.ts` runs it against the process.
export const app = new Application('heimdall-hub', {
  description: 'Store Reports from every System and serve the dashboard.',
  plugins: [help(), version(), config({ file: '.heimdall-hub.{toml,json}' }), signals()],
  version: packageJson.version,
  // Loom's line (`<name> v<version>`) has no room for the Report schema version yet;
  // HMD-13 swaps this override for Loom's version postfix once LM-s22 ships.
  views: [override(loomVersionLine, { render: () => `${versionLine()}\n` })],
}).command(serve);
