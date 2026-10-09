import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { MAX_TRANSCRIPT_SOURCES, SOURCE_NAME } from '@heimdall/schema';

import { isRecord } from '../json.ts';

export type Harness = 'claude-code' | 'codex';

// One place the Collector reads agent Session transcripts from: a Harness's
// directory, and the trees inside it that hold transcripts.
export type Source = { dir: string; harness: Harness; name: string; trees: readonly string[] };

// Where each Harness keeps its transcripts: the directory under the home
// directory, and the trees within it the Collector reads.
export const HARNESSES: Record<Harness, { defaultDir: string; trees: readonly string[] }> = {
  'claude-code': { defaultDir: '.claude', trees: ['projects'] },
  codex: { defaultDir: '.codex', trees: ['sessions'] },
};

type Refused = { kind: 'refused'; problem: string };

const refused = (problem: string): Refused => ({ kind: 'refused', problem });

const isHarness = (value: string): value is Harness => Object.hasOwn(HARNESSES, value);

// The first key of `value` outside `allowed`, if any.
const strayKey = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).find((key) => !allowed.includes(key));

// One `[[sessions.sources]]` entry as written, or the sentence naming what is
// wrong with it. Only strings are accepted for its three keys.
const readEntry = (entry: unknown): Entry | Refused => {
  if (!isRecord(entry)) {
    return refused('each sessions.sources entry must be a table with a harness.');
  }
  const stray = strayKey(entry, ['dir', 'harness', 'name']);
  if (stray !== undefined) {
    return refused(`sessions.sources has the unknown key "${stray}"; use harness, dir, and name.`);
  }
  const { dir, harness, name } = entry;
  if (typeof harness !== 'string') {
    return refused('each sessions.sources entry must set harness to a string.');
  }
  if (dir !== undefined && typeof dir !== 'string') {
    return refused('sessions.sources dir must be a string.');
  }
  if (name !== undefined && typeof name !== 'string') {
    return refused('sessions.sources name must be a string.');
  }
  return { dir, harness, name };
};

// The entries of a `sessions` value, or the sentence naming what is wrong with
// its shape. A section without `sources` lists none.
const readEntries = (section: unknown): unknown[] | Refused => {
  if (!isRecord(section)) {
    return refused('sessions must be a table holding a sources list.');
  }
  const stray = strayKey(section, ['sources']);
  if (stray !== undefined) {
    return refused(`sessions has the unknown key "${stray}"; the only key is sources.`);
  }
  if (section.sources === undefined) {
    return [];
  }
  return Array.isArray(section.sources)
    ? section.sources
    : refused('sessions.sources must be a list of [[sessions.sources]] tables.');
};

// An absolute path, from `~`, `~/...`, or an absolute directory; undefined for
// anything else.
const resolveDir = (dir: string, home: string) => {
  if (dir === '~' || dir.startsWith('~/')) {
    return resolve(home, dir.slice(2));
  }
  return isAbsolute(dir) ? resolve(dir) : undefined;
};

type Entry = { dir?: string | undefined; harness: string; name?: string | undefined };

const buildSource = (entry: Entry, home: string): Source | Refused => {
  if (!isHarness(entry.harness)) {
    return refused(
      `sessions.sources names the unknown harness "${entry.harness}"; use one of ${Object.keys(HARNESSES).join(', ')}.`,
    );
  }
  const { defaultDir, trees } = HARNESSES[entry.harness];
  const name = entry.name ?? entry.harness;
  if (!SOURCE_NAME.test(name)) {
    return refused(
      `the sessions.sources name "${name}" must be lowercase letters, digits, and hyphens, starting and ending with a letter or digit.`,
    );
  }
  const dir = entry.dir === undefined ? join(home, defaultDir) : resolveDir(entry.dir, home);
  if (dir === undefined) {
    return refused(
      `the sessions.sources dir "${entry.dir}" must be absolute or start with ~/; write the full path.`,
    );
  }
  return { dir, harness: entry.harness, name, trees };
};

// The first name or directory two sources share, as a sentence; undefined when
// each is distinct. Paths compare as resolved strings, never through the filesystem.
const findClash = (sources: readonly Source[]): string | undefined => {
  const names = new Set<string>();
  const dirs = new Set<string>();
  for (const { dir, name } of sources) {
    if (names.has(name)) {
      return `two sessions.sources share the name "${name}"; give one a distinct name.`;
    }
    if (dirs.has(dir)) {
      return `two sessions.sources read the directory "${dir}"; list it once.`;
    }
    names.add(name);
    dirs.add(dir);
  }
  return undefined;
};

// The sources a Collector's `sessions` configuration lists, or the one problem
// that makes the whole section unusable. No section or no sources means capture
// is off. Nothing here touches the filesystem: an absent directory is the
// uploader's business.
export const parseSources = (
  section: unknown,
  home: string,
): { kind: 'sources'; sources: Source[] } | Refused => {
  if (section === undefined) {
    return { kind: 'sources', sources: [] };
  }
  const entries = readEntries(section);
  if ('kind' in entries) {
    return entries;
  }
  if (entries.length > MAX_TRANSCRIPT_SOURCES) {
    return refused(
      `sessions.sources lists ${String(entries.length)} sources; keep at most ${String(MAX_TRANSCRIPT_SOURCES)}.`,
    );
  }
  const sources: Source[] = [];
  for (const raw of entries) {
    const entry = readEntry(raw);
    if ('kind' in entry) {
      return entry;
    }
    const built = buildSource(entry, home);
    if ('kind' in built) {
      return built;
    }
    sources.push(built);
  }
  const clash = findClash(sources);
  return clash === undefined ? { kind: 'sources', sources } : refused(clash);
};

// The sentence naming two sources whose directories are one on disk, through
// a symbolic link or a case-insensitive file system, which `parseSources`
// cannot see; undefined when each is distinct. A directory that is not there
// shares nothing.
export const findSharedDirectory = async (
  sources: readonly Source[],
): Promise<string | undefined> => {
  const found = await Promise.all(
    sources.map(async (source) => {
      const stats = await stat(source.dir).catch(() => undefined);
      return stats === undefined ? undefined : `${String(stats.dev)}:${String(stats.ino)}`;
    }),
  );
  const seen = new Map<string, Source>();
  for (const [index, source] of sources.entries()) {
    const identity = found[index];
    if (identity === undefined) {
      continue;
    }
    const other = seen.get(identity);
    if (other !== undefined) {
      return `the sessions.sources "${other.name}" and "${source.name}" read one directory, ${source.dir}; list it once.`;
    }
    seen.set(identity, source);
  }
  return undefined;
};
