import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  open,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { memoryHub } from '../testing/memory-hub.ts';
import { createCapture } from './capture.ts';
import type { TranscriptHub } from './hub-client.ts';
import type { Source } from './sources.ts';
import { openSpool } from './spool.ts';
import type { Spool } from './spool.ts';

const NOW = Date.UTC(2026, 9, 9, 12);
const SESSION = 'projects/my-project/0b1c.jsonl';

// A Claude Code source in a fresh directory, a spool in a fresh state
// directory, and a capture of that source into an in-memory Hub.
const setUp = async ({
  chunkLimit,
  readBytes,
  wrapSpool = (spool) => spool,
}: {
  chunkLimit?: number;
  readBytes?: number;
  wrapSpool?: (spool: Spool) => Spool;
} = {}) => {
  const root = await tempStateDir();
  const source: Source = {
    dir: join(root.path, 'claude'),
    harness: 'claude-code',
    name: 'claude-code',
    trees: ['projects'],
  };
  await mkdir(join(source.dir, 'projects'), { recursive: true });
  const stateDir = join(root.path, 'state');
  const remote = memoryHub();
  const warnings: string[] = [];
  const clock = { now: NOW };
  const spool = await openSpool({ stateDir });
  const capture = (sources: Source[] = [source], hub: TranscriptHub = remote.hub) =>
    createCapture({
      chunkLimit,
      hub,
      log: { warn: (message) => warnings.push(message) },
      now: () => clock.now,
      readBytes,
      sources,
      spool: wrapSpool(spool),
    });
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(source.dir, path)), { recursive: true });
    await writeFile(join(source.dir, path), content);
  };
  const append = (path: string, content: string) => appendFile(join(source.dir, path), content);
  // One scan and one drain, as one tick of the capture loop.
  const tick = async (c = capture()) => {
    await c.scan();
    return c.drain();
  };
  return {
    append,
    capture,
    clock,
    remote,
    root,
    source,
    spool,
    stateDir,
    tick,
    warnings,
    write,
    [Symbol.asyncDispose]: async () => {
      spool.close();
      await root[Symbol.asyncDispose]();
    },
  };
};

describe('a JSONL transcript', () => {
  test('reaches the Hub as written, at its path within the source', async () => {
    await using t = await setUp();
    await t.write(SESSION, '{"a":1}\n{"b":2}\n');

    expect(await t.tick()).toEqual({ kind: 'drained' });

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n{"b":2}\n']);
  });

  test('grows in the same generation', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n{"b":2}\n']);
    expect(t.remote.opens).toHaveLength(1);
  });

  test('keeps a partial last line until the file is unchanged for a scan', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n{"b":');
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n']);

    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n{"b":']);
  });

  test('a line longer than the chunk limit is split, and the Hub joins it', async () => {
    await using t = await setUp({ chunkLimit: 8 });
    await t.write(SESSION, `${'x'.repeat(20)}\n{"b":2}\n`);
    await t.tick();

    expect(t.remote.contents('claude-code', SESSION)).toEqual([`${'x'.repeat(20)}\n{"b":2}\n`]);
  });

  test('chunks spooled during an outage go to the Hub joined, within the limit', async () => {
    await using t = await setUp({ chunkLimit: 8 });
    const c = t.capture();
    t.remote.state.down = true;
    await t.write(SESSION, 'a\n');
    for (const line of ['b\n', 'c\n', 'd\n', 'e\n', 'f\n']) {
      // oxlint-disable-next-line no-await-in-loop -- one scan per line.
      await t.tick(c);
      // oxlint-disable-next-line no-await-in-loop -- one scan per line.
      await t.append(SESSION, line);
    }
    t.remote.state.down = false;
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['a\nb\nc\nd\ne\nf\n']);
    expect(t.remote.sends.map((s) => s.offset)).toEqual([0, 8]);
  });
});

describe('a new generation', () => {
  test('opens when the file shrinks', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n{"b":2}\n');
    await t.tick(c);
    await t.write(SESSION, '{"c":3}\n');
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n{"b":2}\n', '{"c":3}\n']);
  });

  test('opens when the file is replaced by another', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    await t.write('projects/other.jsonl', '{"a":1}\n{"z":9}\n');
    await rename(join(t.source.dir, 'projects/other.jsonl'), join(t.source.dir, SESSION));
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n', '{"a":1}\n{"z":9}\n']);
  });

  test('opens at the next scan when bytes already uploaded change, never splicing two contents', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    await t.write(SESSION, '{"A":1}\n{"b":2}\n');
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n']);

    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n', '{"A":1}\n{"b":2}\n']);
  });

  test('opens when the Collector has no record of the file', async () => {
    await using t = await setUp();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick();
    t.spool.close();
    await rm(t.stateDir, { force: true, recursive: true });
    const fresh = await openSpool({ stateDir: t.stateDir });
    try {
      const c = createCapture({
        hub: t.remote.hub,
        log: { warn: () => {} },
        now: () => NOW,
        sources: [t.source],
        spool: fresh,
      });
      await c.scan();
      await c.drain();
    } finally {
      fresh.close();
    }

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n', '{"a":1}\n']);
  });

  test('opens when the Hub holds more of the generation than the file has', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    // A Hub that claims more than was ever sent, once.
    let lied = false;
    const ahead: TranscriptHub = {
      open: t.remote.hub.open,
      send: async (chunk) => {
        if (!lied) {
          lied = true;
          return { held: 1000, kind: 'elsewhere' };
        }
        return t.remote.hub.send(chunk);
      },
    };
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(t.capture([t.source], ahead));
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n', '{"a":1}\n{"b":2}\n']);
  });
});

// Overwrites `length` bytes at `position`, keeping the file's identity and size.
const overwrite = async (path: string, position: number, text: string) => {
  const handle = await open(path, 'r+');
  try {
    await handle.write(text, position);
  } finally {
    await handle.close();
  }
};

describe('the bytes already read', () => {
  // A file past the hashed windows: its head, its middle, and its tail.
  const LONG = `${'h'.repeat(4096)}\n${'m'.repeat(8192)}\n${'t'.repeat(4096)}\n`;

  test('growing past the hashed window keeps one generation', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, `${'x'.repeat(5000)}\n`);
    for (const line of ['{"i":0}\n', '{"i":1}\n', '{"i":2}\n']) {
      // oxlint-disable-next-line no-await-in-loop -- one scan per line.
      await t.append(SESSION, line);
      // oxlint-disable-next-line no-await-in-loop -- one scan per line.
      await t.tick(c);
    }
    await t.tick(c);

    expect(t.remote.opens).toHaveLength(1);
  });

  test.each([
    ['its first bytes', 10],
    ['the bytes just before where it stopped', LONG.length - 10],
  ])('changed in %s start a new generation', async (_, position) => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, LONG);
    await t.tick(c);
    await overwrite(join(t.source.dir, SESSION), position, 'Z');
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toHaveLength(2);
  });

  test('rewritten in place during a read of several blocks is never spliced', async () => {
    const v1 = 'a\n'.repeat(200);
    const v2 = 'b\n'.repeat(200);
    let appended = 0;
    const file = { path: '' };
    await using t = await setUp({
      chunkLimit: 16,
      readBytes: 64,
      wrapSpool: (spool) => ({
        ...spool,
        append: (...args) => {
          spool.append(...args);
          appended += 1;
          if (appended === 1) {
            // Between two blocks of one read, so it must be synchronous.
            // oxlint-disable-next-line node/no-sync -- see above.
            writeFileSync(file.path, v2);
          }
        },
      }),
    });
    file.path = join(t.source.dir, SESSION);
    await t.write(SESSION, v1);
    const c = t.capture();
    for (let tick = 0; tick < 3; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- scans are sequential.
      await t.tick(c);
    }

    const held = t.remote.contents('claude-code', SESSION);
    expect(held.every((content) => v1.startsWith(content) || v2.startsWith(content))).toBe(true);
    expect(held.at(-1)).toBe(v2);
  });
});

describe('a file that is not JSONL', () => {
  const META = 'projects/my-project/0b1c/subagents/agent-1.meta.json';

  test('uploads whole once unchanged across two scans', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(META, '{"kind":"meta"');
    await t.tick(c);

    expect(t.remote.contents('claude-code', META)).toEqual([]);

    await t.tick(c);

    expect(t.remote.contents('claude-code', META)).toEqual(['{"kind":"meta"']);
  });

  test('changed after upload, uploads again whole in a new generation', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(META, '{"kind":"meta"}');
    await t.tick(c);
    await t.tick(c);
    await t.write(META, '{"kind":"meta","more":true}');
    await t.tick(c);

    expect(t.remote.contents('claude-code', META)).toEqual(['{"kind":"meta"}']);

    await t.tick(c);

    expect(t.remote.contents('claude-code', META)).toEqual([
      '{"kind":"meta"}',
      '{"kind":"meta","more":true}',
    ]);
  });

  test('with lines in it, still waits until it holds still', async () => {
    await using t = await setUp();
    await t.write('projects/p/out.txt', 'line 1\nline 2\n');
    await t.tick();

    expect(t.remote.opens).toEqual([]);
  });

  test('appended to after upload, uploads again whole in a new generation', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write('projects/p/out.txt', 'abc');
    await t.tick(c);
    await t.tick(c);
    await t.append('projects/p/out.txt', 'def');
    await t.tick(c);
    await t.tick(c);

    expect(t.remote.contents('claude-code', 'projects/p/out.txt')).toEqual(['abc', 'abcdef']);
  });
});

describe('the spool', () => {
  test('keeps content through a Hub outage, so a file the Harness deletes still arrives', async () => {
    await using t = await setUp();
    const c = t.capture();
    t.remote.state.down = true;
    await t.write(SESSION, '{"a":1}\n');

    expect(await t.tick(c)).toEqual({ kind: 'failed', reason: 'Hub down' });

    await rm(join(t.source.dir, SESSION));
    t.remote.state.down = false;
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n']);
    expect(t.spool.summary()).toEqual({ bytes: 0, oldestAt: null });
  });

  test('reports what it holds and when the oldest of it was spooled', async () => {
    await using t = await setUp();
    const c = t.capture();
    t.remote.state.down = true;
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    t.clock.now = NOW + 60_000;
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);

    const summary = t.spool.summary();
    expect(summary.oldestAt).toBe(NOW);
    expect(summary.bytes).toBeGreaterThan(0);
  });

  test('uploads what a removed source left spooled, then nothing more from it', async () => {
    await using t = await setUp();
    t.remote.state.down = true;
    await t.write(SESSION, '{"a":1}\n');
    await t.tick();
    t.remote.state.down = false;
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(t.capture([]));
    await t.tick(t.capture([]));

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n']);
  });
});

describe('content deleted on purpose on the Hub', () => {
  test('a path refused as deleted is dropped from the spool and never uploaded again', async () => {
    await using t = await setUp();
    const c = t.capture();
    t.remote.deletePath('claude-code', SESSION);
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);

    expect(t.remote.opens).toEqual([`claude-code/${SESSION}`]);
    expect(t.spool.summary().bytes).toBe(0);
  });

  test('a path deleted while its file grows stops without reading the file again', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    t.remote.deletePath('claude-code', SESSION);
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);
    await t.append(SESSION, '{"c":3}\n');
    await t.tick(c);

    expect(t.remote.opens).toEqual([`claude-code/${SESSION}`, `claude-code/${SESSION}`]);
    expect(t.spool.summary().bytes).toBe(0);
  });

  test('a deleted generation is dropped, and the file uploads again in a new one', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    t.remote.deleteGeneration(1);
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n{"b":2}\n']);
  });
});

describe('a Hub that refuses', () => {
  test("one file's requests leaves the file spooled while the others upload", async () => {
    await using t = await setUp();
    const picky: TranscriptHub = {
      open: async (file) =>
        file.path.includes('bad')
          ? { kind: 'refused', reason: 'Hub answered 422' }
          : t.remote.hub.open(file),
      send: t.remote.hub.send,
    };
    await t.write('projects/a-bad.jsonl', '{"a":1}\n');
    await t.write('projects/b-good.jsonl', '{"b":1}\n');

    expect(await t.tick(t.capture([t.source], picky))).toEqual({
      kind: 'failed',
      reason: 'Hub answered 422',
    });
    expect(t.remote.contents('claude-code', 'projects/b-good.jsonl')).toEqual(['{"b":1}\n']);
    expect(t.spool.summary().bytes).toBeGreaterThan(0);
    expect(t.warnings.some((w) => w.includes('a-bad.jsonl'))).toBe(true);
  });

  test('every chunk of a generation it just opened fails the drain instead of looping', async () => {
    await using t = await setUp();
    const forgetful: TranscriptHub = {
      open: t.remote.hub.open,
      send: () => Promise.resolve({ kind: 'unknown' }),
    };
    await t.write(SESSION, '{"a":1}\n');

    expect((await t.tick(t.capture([t.source], forgetful))).kind).toBe('failed');
    expect(t.spool.summary().bytes).toBeGreaterThan(0);
  });
});

describe('a Hub that lost content', () => {
  test('without the generation, gets the whole file again in a new one', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    t.remote.forgetAll();
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a":1}\n{"b":2}\n']);
  });

  test('holding less than the Collector already sent, gets the whole file in a new one', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    t.remote.truncate(1, 3);
    await t.append(SESSION, '{"b":2}\n');
    await t.tick(c);
    await t.tick(c);

    expect(t.remote.contents('claude-code', SESSION)).toEqual(['{"a', '{"a":1}\n{"b":2}\n']);
  });
});

describe('walking a source', () => {
  test('reads only its session trees', async () => {
    await using t = await setUp();
    await t.write('history.jsonl', '{"prompt":"x"}\n');
    await t.write(SESSION, '{"a":1}\n');
    await t.tick();

    expect(t.remote.opens).toEqual([`claude-code/${SESSION}`]);
  });

  test('does not follow symbolic links', async () => {
    await using t = await setUp();
    await t.write('elsewhere/secret.jsonl', '{"s":1}\n');
    await symlink(join(t.source.dir, 'elsewhere'), join(t.source.dir, 'projects/link'));
    await symlink(
      join(t.source.dir, 'elsewhere/secret.jsonl'),
      join(t.source.dir, 'projects/s.jsonl'),
    );
    await t.tick();

    expect(t.remote.opens).toEqual([]);
  });

  test('skips a file whose name is not UTF-8, warning once', async () => {
    await using t = await setUp();
    const c = t.capture();
    const bad = Buffer.concat([
      Buffer.from(join(t.source.dir, 'projects/bad')),
      Buffer.from([255]),
      Buffer.from('.jsonl'),
    ]);
    await writeFile(bad, '{"a":1}\n');
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    await t.tick(c);

    expect(t.remote.opens).toEqual([`claude-code/${SESSION}`]);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('not UTF-8');
  });

  test('reports each source as capturing, absent, or unreadable', async () => {
    await using t = await setUp();
    const absent: Source = { ...t.source, dir: join(t.root.path, 'nowhere'), name: 'gone' };
    const locked: Source = { ...t.source, dir: join(t.root.path, 'locked'), name: 'locked' };
    await mkdir(locked.dir);
    await chmod(locked.dir, 0o000);
    try {
      const c = t.capture([t.source, absent, locked]);
      await c.scan();

      expect(c.section().sources).toEqual([
        { harness: 'claude-code', name: 'claude-code', status: 'capturing' },
        { harness: 'claude-code', name: 'gone', status: 'absent' },
        { harness: 'claude-code', name: 'locked', status: 'unreadable' },
      ]);
    } finally {
      await chmod(locked.dir, 0o700);
    }
  });

  test('reports no sources and an empty spool when capture is off', async () => {
    await using t = await setUp();
    const c = t.capture([]);
    await c.scan();

    expect(c.section()).toEqual({ sources: [], spool: { bytes: 0, oldestAt: null } });
  });

  test('one file it cannot read is skipped with a warning, and the rest upload', async () => {
    await using t = await setUp();
    await t.write('projects/a.jsonl', '{"a":1}\n');
    await t.write('projects/b.jsonl', '{"b":1}\n');
    await chmod(join(t.source.dir, 'projects/a.jsonl'), 0o000);
    try {
      await t.tick();
    } finally {
      await chmod(join(t.source.dir, 'projects/a.jsonl'), 0o600);
    }

    expect(t.remote.contents('claude-code', 'projects/b.jsonl')).toEqual(['{"b":1}\n']);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('a.jsonl');
  });

  test('reports a source whose session tree cannot be listed as unreadable', async () => {
    await using t = await setUp();
    await chmod(join(t.source.dir, 'projects'), 0o000);
    try {
      const c = t.capture();
      await c.scan();

      expect(c.section().sources[0]?.status).toBe('unreadable');
    } finally {
      await chmod(join(t.source.dir, 'projects'), 0o700);
    }
  });

  test('stops reading once the Collector is stopping', async () => {
    await using t = await setUp();
    await t.write(SESSION, '{"a":1}\n');
    const stopping = new AbortController();
    stopping.abort();
    const c = createCapture({
      hub: t.remote.hub,
      log: { warn: () => {} },
      now: () => NOW,
      signal: stopping.signal,
      sources: [t.source],
      spool: t.spool,
    });
    await c.scan();

    expect(t.spool.summary().bytes).toBe(0);
  });

  test('a file that shrinks to nothing between scans is not an error', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    await truncate(join(t.source.dir, SESSION), 0);

    expect(await t.tick(c)).toEqual({ kind: 'drained' });
    expect(t.warnings).toEqual([]);
  });
});
