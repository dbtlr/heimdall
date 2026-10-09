import type { ActionHandler } from '@loomcli/core';

import type { deleteTranscripts } from './application.ts';
import { withDatabase } from './commands.ts';
import { deleteTranscripts as deleteGenerations } from './transcripts.ts';

const count = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

// `heimdall-hub transcripts delete`: deletes whole generations matching every
// filter given, or with --dry-run says what it would delete (ADR-0013). At
// least one filter is required, so no typo deletes the whole archive.
export const deleteTranscriptsAction: ActionHandler<typeof deleteTranscripts> = async ({
  options,
  out,
  style,
}) => {
  const { before, source, system } = options;
  if (before === undefined && source === undefined && system === undefined) {
    out.fatal('Name what to delete with --system, --source, or --before.');
  }
  const dryRun = options['dry-run'] ?? false;
  const removed = await withDatabase(options.database, { out, style }, (sql) =>
    deleteGenerations(sql, {
      dryRun,
      now: Date.now(),
      ...(before === undefined ? {} : { before: Date.parse(`${before}T00:00:00Z`) }),
      ...(source === undefined ? {} : { source }),
      ...(system === undefined ? {} : { system }),
    }),
  );
  await out.print(
    `${dryRun ? 'Would delete' : 'Deleted'} ${count(removed.generations, 'generation')} of transcripts, ${count(removed.bytes, 'gzipped byte')}.`,
  );
};
