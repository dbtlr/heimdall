import { serviceCommand } from '@heimdall/service';
import { Application, plugin } from '@loomcli/core';
import { config } from '@loomcli/plugins/config';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';

import { serveCommand } from './cli/serve.ts';
import type { BuiltServer } from './cli/serve.ts';
import { DASHBOARD_VERSION, versionPostfix } from './version.ts';

export type { BuiltServer } from './cli/serve.ts';

// SIGTERM from systemd and SIGINT from a terminal cancel `serve`, which stops listening.
const signals = () => plugin('@heimdall/dashboard/signals', { signals: ['SIGINT', 'SIGTERM'] });

// The `heimdall-dashboard` command line. `loadServer` loads the app Vite
// built; tests give it their own, and a shorter `idleTimeout` in seconds.
export const createApp = ({
  idleTimeout,
  loadServer,
}: {
  idleTimeout?: number | undefined;
  loadServer: () => Promise<BuiltServer>;
}) =>
  new Application('heimdall-dashboard', {
    description: "Serve the dashboard of every System, read from the Hub's database.",
    plugins: [
      help(),
      version({ postfix: versionPostfix }),
      config({ file: '.config/heimdall/dashboard.{toml,json}' }),
      signals(),
    ],
    version: DASHBOARD_VERSION,
  })
    .command(serveCommand(loadServer, idleTimeout))
    .command(serviceCommand({ binary: 'dashboard', version: DASHBOARD_VERSION }));

// The command line `main.ts` runs, over the build in `.output/server/`, which a
// compiled binary carries inside it.
export const app = createApp({
  loadServer: async () => (await import('#server-build')).default,
});
