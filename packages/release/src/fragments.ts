import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FragmentCheck } from './repository.ts';

// Characters a fragment may not hold: C0 and C1 controls except tab and line
// feed (so a carriage return, and terminal escapes that survive into release
// notes, fail), zero-width and direction-changing marks, line and paragraph
// separators, and the BOM.
const CONTROL_CHARACTER =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point.
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u;

const GUIDE = 'README.md';

// The pending fragments in `.changes/`, as repository paths: every top-level
// Markdown file but the guide and hidden files, which is what `loom changelog
// check` counts. The guard's name check reports a hidden file instead.
export const pendingFragments = async (root: string): Promise<string[]> => {
  const entries = await readdir(join(root, '.changes'), { withFileTypes: true });
  return entries
    .filter(({ name }) => name.endsWith('.md') && name !== GUIDE && !name.startsWith('.'))
    .map(({ name }) => `.changes/${name}`)
    .toSorted();
};

// What is wrong with a fragment's bytes as plain text, or undefined.
export const plainTextProblem = (bytes: Uint8Array): string | undefined => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'not valid UTF-8; fragments hold plain text';
  }
  const at = text.split('\n').findIndex((line) => CONTROL_CHARACTER.test(line));
  return at === -1
    ? undefined
    : `line ${String(at + 1)}: control character or invisible mark; fragments hold plain text with LF line endings`;
};

// One problem line per pending fragment that is not plain text.
export const plainTextProblems = async (root: string, paths: string[]): Promise<string[]> => {
  const problems = await Promise.all(
    paths.map(async (path) => {
      const problem = plainTextProblem(await readFile(join(root, path)));
      return problem === undefined ? undefined : `${path}: ${problem}`;
    }),
  );
  return problems.filter((problem) => problem !== undefined);
};

// Every reason a `loom changelog check` result fails the guard, one per line:
// Loom's own report, a warning it printed while passing, a pass that counted
// fewer fragments than are pending, and each fragment that is not plain text.
export const fragmentCheckProblems = (
  check: FragmentCheck,
  pending: number,
  plain: string[],
): string[] => {
  if (check.kind === 'unrunnable') {
    return [`Could not run loom changelog check: ${check.reason}`, ...plain];
  }
  if (check.kind === 'failed') {
    return [...check.lines, ...plain];
  }
  const checked = check.checked === undefined ? 'an unknown number of' : String(check.checked);
  const unchecked =
    check.checked === pending
      ? []
      : [
          `loom changelog check checked ${checked} fragments, but ${String(pending)} ${pending === 1 ? 'is' : 'are'} pending in .changes/; check packages/collector/loom.config.json.`,
        ];
  return [...check.warnings, ...unchecked, ...plain];
};
