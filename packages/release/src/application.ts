import { Application, Command } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';
import { text } from '@loomcli/validators';

import packageJson from '../package.json' with { type: 'json' };
import { guardAction, versionAction } from './actions.ts';

export const guard = new Command('guard', {
  description: 'Check that a pull request carries the changelog fragment it needs.',
})
  .option('base', {
    description: 'The ref the pull request merges into, such as origin/main.',
    required: true,
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  .option('skip-label', {
    description: 'The pull request carries the skip-changelog label.',
    type: 'boolean',
  })
  .action(guardAction);

// The changelog's cut and notes are `loom changelog`'s, run from the Collector's
// package directory; only the pull request guard is Heimdall's.
const changelog = new Command('changelog', {
  description: 'Guard pull requests for changelog fragments.',
}).command(guard);

export const version = new Command('version', {
  description: 'Print the version the Collector and Hub share.',
}).action(versionAction);

// The `heimdall-release` command line, run from the repository root through
// `bun run release`. `main.ts` runs it against the process.
export const app = new Application('heimdall-release', {
  description: 'Prepare Heimdall releases.',
  plugins: [help()],
  version: packageJson.version,
})
  .command(changelog)
  .command(version);
