import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { isRecord } from '../json.ts';

// The files Loom's config plugin tries in a directory, in its order
// (`.config/heimdall/collector.{toml,json}`).
const CANDIDATES = ['.config/heimdall/collector.toml', '.config/heimdall/collector.json'];

const parseByExtension = (path: string, text: string): unknown => {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  if (path.endsWith('.toml')) {
    // As Loom reads it, so an integer past 2^53 elsewhere in the file still parses.
    return parseToml(body, { integersAsBigInt: 'asNeeded' });
  }
  if (path.endsWith('.yaml') || path.endsWith('.yml')) {
    return Bun.YAML.parse(body);
  }
  return JSON.parse(body) as unknown;
};

// The top-level table the file holds, or undefined when it is unreadable,
// unparseable, or not an object. Nothing about the content leaves this function.
const readTable = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const parsed = parseByExtension(path, await readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// Whether a candidate counts as present, as Loom counts it: anything but a
// missing file or directory, so a file that cannot be read still shadows the
// candidates after it.
const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
};

// The first candidate present in `directory`, as Loom picks it: a later one is
// never a fallback for an earlier one that cannot be used.
const firstCandidate = async (directory: string) => {
  const paths = CANDIDATES.map((candidate) => resolve(directory, candidate));
  const present = await Promise.all(paths.map((path) => exists(path)));
  return paths.find((_, index) => present[index]);
};

// The table the directory's first candidate holds, if it is usable.
const readDirectory = async (directory: string) => {
  const path = await firstCandidate(directory);
  return path === undefined ? undefined : readTable(path);
};

// The home directory Loom's config plugin looks in: HOME, when it is an
// absolute path, and none otherwise.
export const configHome = (env: Readonly<Record<string, string | undefined>>) => {
  const home = env.HOME;
  return home !== undefined && isAbsolute(home) ? home : undefined;
};

// The `sessions` value of the file Loom's config plugin reads for this run:
// the file `--config` names (the only file when given), otherwise the first
// candidate found in the working directory and then in the home directory,
// when there is one. Loom has already warned about or failed on a file it
// cannot use, so a missing or unparseable file, or one without the key,
// yields undefined and never throws.
export const readSessionsSection = async ({
  cwd,
  home,
  named,
}: {
  cwd: string;
  home: string | undefined;
  named: string | undefined;
}): Promise<unknown> => {
  if (named !== undefined) {
    return (await readTable(resolve(cwd, named)))?.sessions;
  }
  const directories = home === undefined || resolve(home) === resolve(cwd) ? [cwd] : [cwd, home];
  const tables = await Promise.all(directories.map((directory) => readDirectory(directory)));
  return tables.find((table) => table !== undefined)?.sessions;
};
