import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { check, guard, notes, version, write } from './application.ts';
import {
  insertSection,
  isPrerelease,
  parseFragment,
  releaseNotes,
  renderEntries,
  renderSection,
} from './changelog.ts';
import type { FragmentSections } from './changelog.ts';
import { judgeChanges } from './guard.ts';
import {
  CHANGELOG,
  changesSince,
  inLandingOrder,
  pendingFragments,
  refreshLockfile,
  releaseVersion,
  releaseVersionAt,
  removeFragments,
  setReleaseVersion,
} from './repository.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const fragmentCount = (n: number) => `${String(n)} ${n === 1 ? 'fragment' : 'fragments'}`;

// Parses each fragment, collecting every failure rather than stopping at the
// first, so one run lists all that need fixing.
const parseAll = async (root: string, paths: readonly string[]) => {
  const texts = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')));
  const parsed: FragmentSections[] = [];
  const failures: string[] = [];
  for (const [index, path] of paths.entries()) {
    try {
      parsed.push(parseFragment(path, texts[index] ?? ''));
    } catch (error) {
      failures.push(describeError(error));
    }
  }
  return { failures, parsed };
};

// `heimdall-release changelog check`: what the changelog guard runs, so a
// fragment that passes review is one the cut can compile.
export const checkAction: ActionHandler<typeof check> = async ({ args, host, out, style }) => {
  const paths = args.files.length > 0 ? args.files : await pendingFragments(host.cwd);
  const { failures } = await parseAll(host.cwd, paths);
  for (const failure of failures) {
    // oxlint-disable-next-line no-await-in-loop -- failures print in fragment order.
    await out.error(style.escape(escapeControlCharacters(failure)));
  }
  if (failures.length > 0) {
    return out.fatal(`${fragmentCount(failures.length)} failed to parse.`);
  }
  await out.print(`${fragmentCount(paths.length)} ${paths.length === 1 ? 'parses' : 'parse'}.`);
  return undefined;
};

const PARTIAL_CUT =
  'The cut is partly written. Restore the checkout with `git restore .` before you retry.';

// The pending fragments in landing order, parsed. A fragment that fails to
// parse is reported, and the action stops.
const pendingEntries = async (
  root: string,
  out: { error: (message: string) => Promise<void>; fatal: (message: string) => never },
  clean: (message: string) => string,
) => {
  const paths = await inLandingOrder(root, await pendingFragments(root));
  if (paths.length === 0) {
    return out.fatal('No pending fragments in .changes/; a release needs at least one entry.');
  }
  const { failures, parsed } = await parseAll(root, paths);
  for (const failure of failures) {
    // oxlint-disable-next-line no-await-in-loop -- failures print in fragment order.
    await out.error(clean(failure));
  }
  if (failures.length > 0) {
    return out.fatal(`${fragmentCount(failures.length)} failed to parse; nothing changed.`);
  }
  return { parsed, paths };
};

// `heimdall-release changelog write`: the release cut. Every check runs before
// the first write, so a refused cut leaves the checkout as it was. A prerelease
// sets the version only, and its fragments stay pending for the release.
export const writeAction: ActionHandler<typeof write> = async ({ host, options, out, style }) => {
  const root = host.cwd;
  const release = options.version;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const clean = (message: string) => style.escape(escapeControlCharacters(message));

  const changelog = await readFile(join(root, CHANGELOG), 'utf8');
  if (!isPrerelease(release) && releaseNotes(changelog, release) !== undefined) {
    return out.fatal(`${CHANGELOG} already holds v${release}.`);
  }
  try {
    await releaseVersion(root);
  } catch (error) {
    return out.fatal(clean(describeError(error)));
  }
  const { parsed, paths } = await pendingEntries(root, out, clean);

  try {
    if (!isPrerelease(release)) {
      await writeFile(
        join(root, CHANGELOG),
        insertSection(changelog, renderSection(release, date, parsed)),
      );
      await removeFragments(root, paths);
    }
    await setReleaseVersion(root, release);
    await refreshLockfile(root);
  } catch (error) {
    return out.fatal(`${clean(describeError(error))} ${PARTIAL_CUT}`);
  }
  if (isPrerelease(release)) {
    const stay = paths.length === 1 ? 'stays' : 'stay';
    await out.print(
      `Set v${release}; ${fragmentCount(paths.length)} ${stay} pending for the release.`,
    );
  } else {
    await out.print(`Wrote v${release} from ${fragmentCount(paths.length)}.`);
  }
  return undefined;
};

// `heimdall-release changelog notes`: the release workflow's notes source. A
// release's notes are its CHANGELOG.md section; a prerelease's are the
// fragments still pending at its tag.
export const notesAction: ActionHandler<typeof notes> = async ({ host, options, out, style }) => {
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  let body: string | undefined;
  if (isPrerelease(options.version)) {
    body = renderEntries((await pendingEntries(host.cwd, out, clean)).parsed);
  } else {
    body = releaseNotes(await readFile(join(host.cwd, CHANGELOG), 'utf8'), options.version);
  }
  if (body === undefined) {
    return out.fatal(`${CHANGELOG} has no v${options.version} section.`);
  }
  await out.render(body, { render: (notesText) => notesText });
  return undefined;
};

// `heimdall-release changelog guard`: the changelog guard workflow. It parses
// every fragment the pull request adds or edits with the parser the cut uses.
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
  const { failures } = await parseAll(root, judgement.fragments);
  for (const failure of failures) {
    // oxlint-disable-next-line no-await-in-loop -- failures print in fragment order.
    await out.error(clean(failure));
  }
  if (failures.length > 0) {
    return out.fatal(`${fragmentCount(failures.length)} failed to parse.`);
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
