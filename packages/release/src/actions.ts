import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { guard, version } from './application.ts';
import { judgeChanges } from './guard.ts';
import { changesSince, checkFragments, releaseVersion, releaseVersionAt } from './repository.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// `heimdall-release changelog guard`: the changelog guard workflow. It parses
// every pending fragment with `loom changelog check`, the grammar the cut uses.
export const guardAction: ActionHandler<typeof guard> = async ({ host, options, out, style }) => {
  const root = host.cwd;
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  let judgement;
  try {
    const [changes, before, after] = await Promise.all([
      changesSince(root, options.base),
      releaseVersionAt(root, options.base),
      releaseVersion(root),
    ]);
    judgement = judgeChanges({
      changes,
      skipLabel: options['skip-label'] ?? false,
      versionChanged: before !== after,
    });
  } catch (error) {
    return out.fatal(clean(describeError(error)));
  }
  const invalid = await checkFragments(root);
  if (invalid !== undefined) {
    await out.error(clean(invalid));
    return out.fatal('A changelog fragment is invalid.');
  }
  if (judgement.verdict === 'fail') {
    return out.fatal(clean(judgement.reason));
  }
  await out.print(clean(judgement.reason));
  return undefined;
};

// `heimdall-release version`: what the release workflow compares the tag with.
export const versionAction: ActionHandler<typeof version> = async ({ host, out, style }) => {
  try {
    await out.print(await releaseVersion(host.cwd));
  } catch (error) {
    const message = escapeControlCharacters(describeError(error));
    return out.fatal(style.escape(message));
  }
  return undefined;
};
