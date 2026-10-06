import { Application, Command } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';
import { text } from '@loomcli/validators';

import packageJson from '../package.json' with { type: 'json' };
import { checkAction, notesAction, versionAction, writeAction } from './actions.ts';

// A release version as the tag carries it without the `v`: X.Y.Z, or X.Y.Z-pre
// for a prerelease.
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;

const releaseVersion = text({
  message: 'Use a release version without the v, such as 0.2.0 or 0.2.0-rc.1.',
  pattern: RELEASE_VERSION,
});

export const check = new Command('check', {
  description: 'Check that pending changelog fragments parse.',
})
  .argument('files', {
    description: 'Fragments to check. Defaults to every pending fragment.',
    variadic: true,
  })
  .action(checkAction);

export const write = new Command('write', {
  description: 'Cut a release: compile the fragments into CHANGELOG.md and set the version.',
})
  .option('version', {
    description: 'The release version, such as 0.2.0.',
    required: true,
    type: 'string',
    validate: releaseVersion,
  })
  .option('date', {
    description: 'Release date as YYYY-MM-DD. Defaults to the current UTC date.',
    type: 'string',
    validate: text({ message: 'Use a date such as 2026-10-06.', pattern: /^\d{4}-\d{2}-\d{2}$/u }),
  })
  .action(writeAction);

export const notes = new Command('notes', {
  description: "Print one release's CHANGELOG.md entries, for its GitHub Release.",
})
  .option('version', {
    description: 'The release version, such as 0.2.0.',
    required: true,
    type: 'string',
    validate: releaseVersion,
  })
  .action(notesAction);

const changelog = new Command('changelog', {
  description: 'Check, compile, and read changelog fragments.',
})
  .command(check)
  .command(write)
  .command(notes);

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
