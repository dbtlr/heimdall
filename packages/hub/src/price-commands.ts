import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { pricesUpdate } from './application.ts';
import { withDatabase } from './commands.ts';
import { describeError } from './errors.ts';
import { describeAdded, describeSuspect, updateFetchedPrices } from './fetched-prices.ts';
import { lockTimeoutOption } from './migration-wait.ts';
import { loadPriceOverrides, syncPrices } from './price-table.ts';
import { BUNDLED_PRICES } from './prices.ts';
import { count } from './transcript-commands.ts';

// `heimdall-hub prices update`: loads the bundled and configured prices, as
// `serve` does when it starts, then fetches the price list and adds the
// entries it calls for (ADR-0024). It prints a line for each model it adds
// entries for, or that prices are up to date, then how many models it
// skipped. A failed fetch prints why and exits 1, leaving the loaded prices
// loaded. With the source off, it only loads.
export const pricesUpdateAction: ActionHandler<typeof pricesUpdate> = async ({
  host,
  options,
  out,
  signal,
  style,
}) => {
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  const path = options['price-overrides'];
  // An overrides file that cannot be read stops the command before it touches the database.
  const configured =
    path === undefined
      ? []
      : await loadPriceOverrides(path).catch((error: unknown) =>
          out.fatal(clean(describeError(error))),
        );
  const source = options['price-source'];
  const applied = await withDatabase(
    options.database,
    { ...lockTimeoutOption(host.env), out, signal, style },
    async (sql) => {
      await syncPrices(sql, { bundled: BUNDLED_PRICES, configured });
      return source.kind === 'off'
        ? undefined
        : updateFetchedPrices({ fetch, signal, source: source.url, sql });
    },
  );
  if (applied === undefined) {
    await out.print(
      'Fetching prices is off, so only the bundled and configured prices were loaded.',
    );
    return;
  }
  for (const suspect of applied.skipped.filter(({ kind }) => kind === 'suspect')) {
    // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order.
    await out.warn(clean(describeSuspect(suspect)));
  }
  if (applied.added.length === 0) {
    await out.print('Prices are up to date.');
  }
  for (const added of applied.added) {
    // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order.
    await out.print(clean(describeAdded(added)));
  }
  await out.print(`Skipped ${count(applied.skipped.length, 'model')}.`);
};
