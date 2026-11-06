import { expect, test } from 'bun:test';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { keepLogRotated, rotateLog } from './rotation.ts';
import { tempHome } from './testing.ts';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const stamp = (t: number) => new Date(t).toISOString();

test('a log whose first line is 90 days old is copied to .1 and emptied in place', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  const text = `${stamp(NOW - 90 * DAY_MS)} Listening.\n${stamp(NOW - DAY_MS)} Still here.\n`;
  await writeFile(log, text);
  const inode = (await stat(log)).ino;

  expect(await rotateLog({ now: NOW, path: log })).toBe('rotated');

  expect(await readFile(`${log}.1`, 'utf8')).toBe(text);
  expect(await readFile(log, 'utf8')).toBe('');
  // The supervisor holds the live file open in append mode: it must stay the same file.
  expect((await stat(log)).ino).toBe(inode);
});

test('a younger log is kept as it is', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  const text = `${stamp(NOW - 89 * DAY_MS)} Listening.\n`;
  await writeFile(log, text);

  expect(await rotateLog({ now: NOW, path: log })).toBe('kept');

  expect(await readFile(log, 'utf8')).toBe(text);
  expect(await Bun.file(`${log}.1`).exists()).toBe(false);
});

test('a young log that reaches the size limit rotates, replacing the previous copy', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'collector.log');
  await writeFile(`${log}.1`, 'the previous copy\n');
  const text = `${stamp(NOW)} ${'x'.repeat(300)}\n`;
  await writeFile(log, text);

  expect(await rotateLog({ maxBytes: text.length, now: NOW, path: log })).toBe('rotated');

  expect(await readFile(`${log}.1`, 'utf8')).toBe(text);
  expect(await readFile(log, 'utf8')).toBe('');
});

test('a log just under the size limit is kept', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'collector.log');
  const text = `${stamp(NOW)} ${'x'.repeat(300)}\n`;
  await writeFile(log, text);

  expect(await rotateLog({ maxBytes: text.length + 1, now: NOW, path: log })).toBe('kept');
});

const STARTUP_LINES = '› Ignored host in .config/heimdall/hub.toml: not a key\n';

test('a log holding only untimestamped lines, under the size limit, is kept', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  await writeFile(`${log}.1`, 'the previous copy\n');
  await writeFile(log, STARTUP_LINES);

  expect(await rotateLog({ now: NOW, path: log })).toBe('kept');

  expect(await readFile(log, 'utf8')).toBe(STARTUP_LINES);
  expect(await readFile(`${log}.1`, 'utf8')).toBe('the previous copy\n');
});

test('untimestamped lines before a recent timestamped line leave the log kept', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  await writeFile(log, `${STARTUP_LINES}${stamp(NOW - DAY_MS)} Listening.\n`);

  expect(await rotateLog({ now: NOW, path: log })).toBe('kept');
});

test('untimestamped lines before a timestamped line older than 90 days rotate the log', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  const text = `${STARTUP_LINES}${stamp(NOW - 91 * DAY_MS)} Listening.\n`;
  await writeFile(log, text);

  expect(await rotateLog({ now: NOW, path: log })).toBe('rotated');

  expect(await readFile(`${log}.1`, 'utf8')).toBe(text);
  expect(await readFile(log, 'utf8')).toBe('');
});

test('untimestamped content at the size limit rotates', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  const text = 'no timestamp here\n'.repeat(20);
  await writeFile(log, text);

  expect(await rotateLog({ maxBytes: text.length, now: NOW, path: log })).toBe('rotated');
  expect(await readFile(`${log}.1`, 'utf8')).toBe(text);
});

test('a timestamped line cut off by the read window is not misread', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  // Only the first 9 characters of the old stamp fall inside the 64 KiB window.
  const filler = `${'x'.repeat(65_535 - 10)}\n`;
  await writeFile(log, `${filler}${stamp(NOW - 91 * DAY_MS)} Listening.\n`);

  expect(await rotateLog({ now: NOW, path: log })).toBe('kept');
});

test('an empty log is kept', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  await writeFile(log, '');

  expect(await rotateLog({ now: NOW, path: log })).toBe('kept');
  expect(await Bun.file(`${log}.1`).exists()).toBe(false);
});

test('a missing log is fine: a hand run has none', async () => {
  await using home = await tempHome();

  expect(await rotateLog({ now: NOW, path: join(home.path, 'hub.log') })).toBe('missing');
});

test('keepLogRotated has rotated the log by the time it resolves, before any line is written', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'hub.log');
  const old = `${stamp(NOW - 91 * DAY_MS)} Listening.\n`;
  await writeFile(log, old);

  const stop = await keepLogRotated({ now: () => NOW, onError: () => {}, path: log });
  await writeFile(log, `${stamp(NOW)} Listening.\n`, { flag: 'a' });
  await stop();

  expect(await readFile(`${log}.1`, 'utf8')).toBe(old);
  expect(await readFile(log, 'utf8')).toBe(`${stamp(NOW)} Listening.\n`);
});

test('a writer that holds the log open in append mode keeps writing from its start', async () => {
  await using home = await tempHome();
  const log = join(home.path, 'collector.log');
  const old = `${stamp(NOW - 91 * DAY_MS)} From an old build.\n`.repeat(50);
  const writer = await open(log, 'a');
  try {
    await writer.write(old);

    expect(await rotateLog({ now: NOW, path: log })).toBe('rotated');
    await writer.write(`${stamp(NOW)} Sampling.\n`);
  } finally {
    await writer.close();
  }

  // O_APPEND writes go to the current end, so no hole of NUL bytes precedes them.
  expect(await readFile(log, 'utf8')).toBe(`${stamp(NOW)} Sampling.\n`);
  expect(await readFile(`${log}.1`, 'utf8')).toBe(old);
});
