import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { check, notes, version, write } from './application.ts';
import { insertSection, parseFragment, releaseNotes, renderSection } from './changelog.ts';
import type { FragmentSections } from './changelog.ts';
import {
  CHANGELOG,
  inLandingOrder,
  pendingFragments,
  refreshLockfile,
  releaseVersion,
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

// `heimdall-release changelog write`: the release cut. It checks everything
// before it changes anything, so a refused cut leaves the checkout as it was.
export const writeAction: ActionHandler<typeof write> = async ({ host, options, out, style }) => {
  const root = host.cwd;
  const release = options.version;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const clean = (message: string) => style.escape(escapeControlCharacters(message));

  const changelog = await readFile(join(root, CHANGELOG), 'utf8');
  if (releaseNotes(changelog, release) !== undefined) {
    return out.fatal(`${CHANGELOG} already holds v${release}.`);
  }
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
    return out.fatal(`${fragmentCount(failures.length)} failed to parse; nothing was written.`);
  }

  try {
    await writeFile(
      join(root, CHANGELOG),
      insertSection(changelog, renderSection(release, date, parsed)),
    );
    await setReleaseVersion(root, release);
    await removeFragments(root, paths);
    await refreshLockfile(root);
  } catch (error) {
    return out.fatal(clean(describeError(error)));
  }
  await out.print(`Wrote v${release} from ${fragmentCount(paths.length)}.`);
  return undefined;
};

// `heimdall-release changelog notes`: the release workflow's notes source.
export const notesAction: ActionHandler<typeof notes> = async ({ host, options, out }) => {
  const changelog = await readFile(join(host.cwd, CHANGELOG), 'utf8');
  const body = releaseNotes(changelog, options.version);
  if (body === undefined) {
    return out.fatal(`${CHANGELOG} has no v${options.version} section.`);
  }
  await out.render(body, { render: (notesText) => notesText });
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
