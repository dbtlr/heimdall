import { mkdir } from 'node:fs/promises';

import { homeOf } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { pair } from './application.ts';
import { describeError } from './errors.ts';
import { identityPath, readIdentity, writeIdentity } from './identity.ts';
import type { IdentityRead } from './identity.ts';
import { MAX_ANSWER_BYTES, redeemCode } from './redeem.ts';
import type { Redemption } from './redeem.ts';
import { defaultStateDir } from './state-dir.ts';

// Why a redemption that gave no identity failed, in words for the operator.
const failure = (outcome: Exclude<Redemption, { kind: 'paired' }>, hub: URL): string => {
  switch (outcome.kind) {
    case 'refused': {
      return 'The Hub refused the code: it is invalid or expired.';
    }
    case 'paused': {
      const wait =
        outcome.retryAfterSeconds === undefined
          ? 'in a minute'
          : `after ${String(outcome.retryAfterSeconds)} seconds`;
      return `The Hub has paused pairing after too many failed codes. Try again ${wait}.`;
    }
    case 'unreachable': {
      return `Could not reach the Hub at ${hub.href}: ${outcome.reason}`;
    }
    case 'unexpected': {
      return `The Hub at ${hub.href} answered ${String(outcome.status)} to the Pairing request.`;
    }
    case 'oversized': {
      return `The Hub's answer was too large (over ${String(MAX_ANSWER_BYTES)} bytes) for a System name and token, so nothing was kept. The code may be spent: run heimdall-hub pair <system> again for a new one.`;
    }
    case 'dropped': {
      return `The connection to the Hub dropped before its answer arrived in full (${outcome.reason}), so nothing was kept. The code may be spent: run heimdall-hub pair <system> again for a new one.`;
    }
    case 'malformed': {
      return `The Hub at ${hub.href} answered, but its answer did not hold a System name and token, so nothing was kept. The code is spent: issue a new one with heimdall-hub pair <system>.`;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
};

// What a new identity replaced, if anything: rotating a System's token ends
// its old one, while an identity for another System leaves that one's token
// on the Hub.
const replacement = (previous: IdentityRead, system: string): string | undefined => {
  switch (previous.kind) {
    case 'not paired': {
      return undefined;
    }
    case 'paired': {
      return previous.identity.system === system
        ? 'This replaced the token this System held; the old one no longer works.'
        : `This replaced its identity as ${previous.identity.system}, whose token works until heimdall-hub unpair ${previous.identity.system}.`;
    }
    case 'invalid': {
      return 'This replaced the identity file that was there, which was not valid.';
    }
    default: {
      const _exhaustive: never = previous;
      return _exhaustive;
    }
  }
};

// Why pairing failed after the Hub had paired the System: the code is spent,
// and when the identity held was for the same System, its token is too.
const lostIdentity = ({
  error,
  path,
  previous,
  system,
}: {
  error: unknown;
  path: string;
  previous: IdentityRead;
  system: string;
}): string => {
  const lost = `The Hub paired this System as ${system}, but its identity could not be kept in ${path}: ${describeError(error)}. The code is spent: issue a new one with heimdall-hub pair ${system}, then run heimdall-collector pair again.`;
  return previous.kind === 'paired' && previous.identity.system === system
    ? `${lost} The Hub has already rotated ${system}'s token, so the token this System holds no longer works, and the Hub refuses its Reports until this System pairs again.`
    : lost;
};

// `heimdall-collector pair <code>`: redeems a Pairing code with the Hub and
// keeps the System name and token it answers, with the Hub's origin, in
// `identity.json` (ADR-0009).
// Only a valid answer writes; every failure leaves an existing identity as it
// was. Neither the code nor the token is ever printed.
export const pairAction: ActionHandler<typeof pair> = async ({
  args,
  host,
  options,
  out,
  style,
}) => {
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  const fail: (message: string) => never = (message) => out.fatal(clean(message));
  const { hub } = options;
  const stateDir =
    options['state-dir'] ??
    defaultStateDir({ env: host.env, home: homeOf(host.env), platform: process.platform });
  // The directory comes first, so a state directory that cannot exist does not
  // spend the code. One `pair` creates is its owner's alone; an existing one keeps its mode.
  await mkdir(stateDir, { mode: 0o700, recursive: true }).catch((error: unknown) =>
    fail(`Could not create the state directory ${stateDir}: ${describeError(error)}`),
  );

  const outcome = await redeemCode({ code: args.code, hub });
  if (outcome.kind !== 'paired') {
    fail(failure(outcome, hub));
  }
  const { system } = outcome.pairing;
  const previous = await readIdentity(stateDir);
  // The identity is bound to the Hub's origin; a path under it may change.
  await writeIdentity(stateDir, { hub: hub.origin, ...outcome.pairing }).catch((error: unknown) =>
    fail(lostIdentity({ error, path: identityPath(stateDir), previous, system })),
  );
  await out.print(clean(`Paired as ${system}.`));
  const replaced = replacement(previous, system);
  if (replaced !== undefined) {
    await out.print(clean(replaced));
  }
  await out.print('If the Collector runs as a Service, run heimdall-collector service restart.');
};
