import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import type { Binary } from './names.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
const firstCandidate = async (directory: string, candidates: readonly string[]) => {
  const paths = candidates.map((candidate) => resolve(directory, candidate));
  const present = await Promise.all(paths.map((path) => exists(path)));
  return paths.find((_, index) => present[index]);
};

// The table the directory's first candidate holds, if it is usable.
const readDirectory = async (directory: string, candidates: readonly string[]) => {
  const path = await firstCandidate(directory, candidates);
  return path === undefined ? undefined : readTable(path);
};

// Loom exposes only scalar config values to options. Nested sections use the
// same file discovery and parsers after Loom has checked the selected file:
// the working directory, then `home`, the run's `host.home`, when it is an
// absolute path, as Loom's config plugin looks there only then.
export const readConfigSection = async ({
  binary,
  section,
  cwd,
  home,
  named,
}: {
  binary: Binary;
  section: string;
  cwd: string;
  home: string;
  named: string | undefined;
}): Promise<unknown> => {
  if (named !== undefined) {
    return (await readTable(resolve(cwd, named)))?.[section];
  }
  const candidates = [`.config/heimdall/${binary}.toml`, `.config/heimdall/${binary}.json`];
  const directories = !isAbsolute(home) || resolve(home) === resolve(cwd) ? [cwd] : [cwd, home];
  const tables = await Promise.all(
    directories.map((directory) => readDirectory(directory, candidates)),
  );
  return tables.find((table) => table !== undefined)?.[section];
};
