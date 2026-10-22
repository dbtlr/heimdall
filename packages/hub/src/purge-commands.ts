import type { ActionHandler } from '@loomcli/core';

import type { purgeService, purgeSystem } from './application.ts';
import { withDatabase } from './commands.ts';
import { purgeService as purgeOneService, purgeSystem as purge } from './purge.ts';
import { count } from './transcript-commands.ts';

// `heimdall-hub purge system <system>`: deletes everything the Hub holds for a
// System that is no longer paired, keeping its transcripts unless
// --transcripts. A paired System, a pending Pairing code, and a name the Hub
// holds nothing for are errors, so a purge never follows a mistyped name.
export const purgeSystemAction: ActionHandler<typeof purgeSystem> = async ({
  args,
  options,
  out,
  signal,
  style,
}) => {
  const { system } = args;
  const transcripts = options.transcripts ?? false;
  const purged = await withDatabase(options.database, { out, signal, style }, (sql) =>
    purge(sql, { system, transcripts }),
  );
  if (purged.kind === 'paired') {
    out.fatal(`${system} is paired. Run heimdall-hub unpair ${system} first.`);
  } else if (purged.kind === 'pending_code') {
    out.fatal(
      `${system} has a pending Pairing code. Run heimdall-hub unpair ${system} to withdraw it first.`,
    );
  } else if (purged.kind === 'nothing') {
    out.fatal(`The Hub holds nothing for ${system}.`);
  } else if (purged.kind === 'transcripts_only') {
    out.fatal(`The Hub holds only transcripts for ${system}. Add --transcripts to delete them.`);
  } else if (purged.transcripts === undefined) {
    await out.print(
      `Purged ${system}. Its transcripts stay; add --transcripts to delete them too.`,
    );
  } else {
    const { bytes, generations } = purged.transcripts;
    await out.print(
      `Purged ${system} and ${count(generations, 'generation')} of its transcripts, ${count(bytes, 'gzipped byte')}.`,
    );
  }
};

// `heimdall-hub purge service <system> <service>`: deletes a forgotten
// Service's Conditions, their Timeline, and their deliveries. A Service its
// System still records, and one the Hub holds nothing for, are errors.
export const purgeServiceAction: ActionHandler<typeof purgeService> = async ({
  args,
  options,
  out,
  signal,
  style,
}) => {
  const { service, system } = args;
  const purged = await withDatabase(options.database, { out, signal, style }, (sql) =>
    purgeOneService(sql, { service, system }),
  );
  if (purged.kind === 'recorded') {
    out.fatal(
      `${system} still records the Service ${service}. Run heimdall-collector forget service ${service} on ${system} first.`,
    );
  } else if (purged.kind === 'nothing') {
    out.fatal(`The Hub holds nothing for the Service ${service} on ${system}.`);
  } else {
    await out.print(`Purged the Service ${service} from ${system}.`);
  }
};
