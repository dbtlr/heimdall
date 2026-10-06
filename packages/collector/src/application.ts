import { Application, NonCallableCommandError, override } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';
import { versionLine as loomVersionLine } from '@loomcli/plugins/version/views';

import packageJson from '../package.json' with { type: 'json' };
import { versionLine } from './version.ts';

// The `heimdall-collector` command line. `main.ts` runs it against the process.
export const app = new Application('heimdall-collector', {
  description: 'Sample this System and push Reports to the Hub.',
  plugins: [help(), version()],
  version: packageJson.version,
  // Loom's own line reads `<name> v<version>`; Fleet compares the Heimdall line instead.
  views: [override(loomVersionLine, { render: () => `${versionLine()}\n` })],
})
  // Loom requires the root to act or route to a command. Until the first command
  // lands, a bare invocation is a usage error; once one does, drop this action.
  .action(() => {
    throw new NonCallableCommandError([], []);
  });
