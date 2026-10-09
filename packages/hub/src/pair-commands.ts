import type { ActionHandler } from '@loomcli/core';

import type { pair, unpair } from './application.ts';
import { withDatabase } from './commands.ts';
import { issueCode, showCode, unpair as unpairSystem } from './pairing.ts';

// `heimdall-hub pair <system>`: issues a Pairing code for the System, replacing
// any code it held, and says how to redeem it (ADR-0009).
export const pairAction: ActionHandler<typeof pair> = async ({ args, options, out, style }) => {
  const { system } = args;
  const issued = await withDatabase(options.database, { out, style }, (sql) =>
    issueCode(sql, { now: Date.now(), system }),
  );
  const shown = showCode(issued.code);
  await out.print(`Pairing code for ${system}: ${shown}`);
  await out.print(`It redeems once and expires at ${new Date(issued.expiresAt).toISOString()}.`);
  if (issued.paired) {
    await out.print(`${system} is paired already. Its token works until this code is redeemed.`);
  }
  await out.print(`On ${system}, run: heimdall-collector pair ${shown}`);
};

// `heimdall-hub unpair <system>`: revokes the System's token and withdraws its
// pending code. Its history stays. A System with neither is an error, so a
// mistyped name does not pass for a revocation.
export const unpairAction: ActionHandler<typeof unpair> = async ({ args, options, out, style }) => {
  const { system } = args;
  const { revoked, withdrawn } = await withDatabase(options.database, { out, style }, (sql) =>
    unpairSystem(sql, system),
  );
  if (revoked) {
    await out.print(
      `Unpaired ${system}. Its token no longer authenticates Reports; its history stays.`,
    );
  } else if (withdrawn) {
    await out.print(`${system} was not paired. Withdrew its pending Pairing code.`);
  } else {
    out.fatal(`${system} is not paired.`);
  }
};
