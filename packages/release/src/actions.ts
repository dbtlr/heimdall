import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { guard, version } from './application.ts';
import { fragmentCheckProblems, pendingFragments, plainTextProblems } from './fragments.ts';
import { judgeChanges } from './guard.ts';
import { changesSince, checkFragments, releaseVersion, releaseVersionAt } from './repository.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Every reason the pending fragments fail the guard, one per line.
const fragmentProblems = async (root: string): Promise<string[]> => {
  const pending = await pendingFragments(root);
  const [check, plain] = await Promise.all([
    checkFragments(root),
    plainTextProblems(root, pending),
  ]);
  return fragmentCheckProblems(check, pending.length, plain);
};

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
  const problems = await fragmentProblems(root);
  if (problems.length > 0) {
    // One line each, in order.
    await problems.reduce(async (previous, problem) => {
      await previous;
      await out.error(clean(problem));
    }, Promise.resolve());
    return out.fatal('The pending changelog fragments are not valid.');
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
