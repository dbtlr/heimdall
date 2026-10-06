import { copyFile, stat, truncate } from 'node:fs/promises';

import { every } from './every.ts';
import { isMissing } from './files.ts';

const DAY_MS = 86_400_000;

// A log rotates when its first line is this old, or it is this large,
// whichever comes first (ADR-0007).
export const LOG_MAX_AGE_MS = 90 * DAY_MS;
export const LOG_MAX_BYTES = 10_000_000;

// The ISO 8601 UTC time that starts every runtime line.
const LEADING_TIME = /^(?<time>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?:\s|$)/u;

// When the log's first line was written, or undefined when it carries no
// timestamp, as in a log written before lines had one.
const firstLineTime = async (path: string) => {
  const head = await Bun.file(path).slice(0, 128).text();
  const time = LEADING_TIME.exec(head)?.groups?.time;
  const parsed = time === undefined ? Number.NaN : Date.parse(time);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const sizeOf = async (path: string) => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
};

// Rotates the log at `path` when it is due: copies it to `<path>.1`, replacing
// any earlier copy, then truncates it in place. The supervisor holds the file
// open in append mode, so renaming it would leave the binary writing to the
// copy. A first line with no timestamp counts as old, so such a log rotates
// once. A missing log is not an error: a run by hand writes to the terminal.
export const rotateLog = async ({
  maxAgeMs = LOG_MAX_AGE_MS,
  maxBytes = LOG_MAX_BYTES,
  now,
  path,
}: {
  maxAgeMs?: number;
  maxBytes?: number;
  now: number;
  path: string;
}): Promise<'kept' | 'missing' | 'rotated'> => {
  const size = await sizeOf(path);
  if (size === undefined) {
    return 'missing';
  }
  if (size === 0) {
    return 'kept';
  }
  if (size < maxBytes) {
    const written = await firstLineTime(path);
    if (written !== undefined && now - written < maxAgeMs) {
      return 'kept';
    }
  }
  await copyFile(path, `${path}.1`);
  await truncate(path, 0);
  return 'rotated';
};

// Checks the log at `path` for `serve` and `run`: once before resolving, so the
// caller writes its first line only after a due rotation, and then about once
// a day. A failed check goes to `onError`. Resolves to the function that stops it.
export const keepLogRotated = async ({
  intervalMs = DAY_MS,
  now = Date.now,
  onError,
  path,
}: {
  intervalMs?: number;
  now?: () => number;
  onError: (error: unknown) => void;
  path: string;
}): Promise<() => Promise<void>> => {
  const task = () => rotateLog({ now: now(), path });
  try {
    await task();
  } catch (error) {
    onError(error);
  }
  return every({ intervalMs, onError, runNow: false, task });
};
