import type { ActionHandler } from '@loomcli/core';

import type { silence } from './application.ts';
import { withDatabase } from './commands.ts';
import { minutesText } from './delivery.ts';
import { parseDuration } from './duration.ts';
import { activeSilences, clearSilence, setSilence } from './silences.ts';

const MINUTE = 60_000;

// `heimdall-hub silence [system]`: with a System and `--for`, holds delivery
// for it until then; with `--clear`, ends its silence; with no System, lists
// the silences holding delivery (ADR-0020). A silence never hides a Condition.
export const silenceAction: ActionHandler<typeof silence> = async ({
  args,
  options,
  out,
  signal,
  style,
}) => {
  const { system } = args;
  const { clear, for: duration } = options;
  if (system === undefined) {
    if (clear || duration !== undefined) {
      out.fatal(
        'Name the System to silence or clear, such as: heimdall-hub silence laptop-1 --for 2h.',
      );
    }
  } else if (clear && duration !== undefined) {
    out.fatal('Use --for or --clear, not both.');
  } else if (!clear && duration === undefined) {
    out.fatal(
      `Give --for <duration> to silence ${system}, such as --for 2h, or --clear to end its silence.`,
    );
  }
  const forMs = duration === undefined ? undefined : parseDuration(duration);
  const context = { out, signal, style };
  const now = Date.now();
  if (system === undefined) {
    const silences = await withDatabase(options.database, context, (sql) =>
      activeSilences(sql, now),
    );
    if (silences.length === 0) {
      await out.print('No active silences.');
    }
    for (const { system: name, until } of silences) {
      // Rounded up, so a silence just set for 2 h reads as 2 h left.
      const left = minutesText(Math.ceil((until.getTime() - now) / MINUTE) * MINUTE);
      // oxlint-disable-next-line no-await-in-loop -- a fleet has a handful of silences.
      await out.print(`${name} until ${until.toISOString()} (${left} left)`);
    }
  } else if (clear) {
    const cleared = await withDatabase(options.database, context, (sql) =>
      clearSilence(sql, system, now),
    );
    if (!cleared) {
      out.fatal(`${system} has no active silence.`);
    }
    await out.print(`Ended the silence on ${system}. Delivery resumes.`);
  } else if (forMs !== undefined) {
    const until = await withDatabase(options.database, context, (sql) =>
      setSilence(sql, { forMs, now, system }),
    );
    if (until === undefined) {
      out.fatal(`${system} is not paired.`);
    } else {
      await out.print(
        `Silenced ${system} until ${until.toISOString()}. Its Conditions stay on the dashboard; delivery holds until then.`,
      );
    }
  }
};
