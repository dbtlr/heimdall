import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Characters a fragment may not hold: C0 and C1 controls except tab and line
// feed (so a carriage return, and terminal escapes that survive into release
// notes, fail), zero-width and direction-changing marks, line and paragraph
// separators, and the BOM.
const CONTROL_CHARACTER =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point.
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u;

const GUIDE = 'README.md';

// The pending fragments in `.changes/`, as repository paths: every top-level
// Markdown file but the guide, which is what `loom changelog check` counts.
export const pendingFragments = async (root: string): Promise<string[]> => {
  const entries = await readdir(join(root, '.changes'), { withFileTypes: true });
  return entries
    .filter(({ name }) => name.endsWith('.md') && name !== GUIDE)
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
