import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { deliveryTest } from './application.ts';
import { configName } from './commands.ts';
import { readDeliveryChannel } from './delivery-config.ts';
import { describeError } from './errors.ts';
import { ntfySender } from './ntfy.ts';

// `heimdall-hub delivery test`: sends one low-priority message through the
// `[delivery]` channel, as `serve` would, and says whether ntfy took it. It
// opens no database. The topic and the token are never printed.
export const deliveryTestAction: ActionHandler<typeof deliveryTest> = async ({
  host,
  options,
  out,
  style,
}) => {
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  const channel =
    (await readDeliveryChannel({ cwd: host.cwd, env: host.env, named: configName(options) }).catch(
      (error: unknown) =>
        out.fatal(clean(`Invalid Hub delivery settings: ${describeError(error)}`)),
    )) ??
    out.fatal('The Hub configuration has no [delivery] section, so alerts are not delivered.');
  await ntfySender(channel)({
    click: channel.dashboard.href,
    message: 'Alert delivery works. This message is only a test.',
    priority: 'low',
    title: 'Heimdall test',
  }).catch((error: unknown) =>
    out.fatal(clean(`Could not send the test message: ${describeError(error)}`)),
  );
  await out.print(`Sent a test message through ${channel.url.host}.`);
};
