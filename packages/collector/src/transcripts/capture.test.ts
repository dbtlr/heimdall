import { describe, expect, test } from 'bun:test';
import {
  appendFile,
  chmod,
  mkdir,
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

const NOW = Date.UTC(2026, 9, 9, 12);
const SESSION = 'projects/my-project/0b1c.jsonl';

// A Claude Code source in a fresh directory, a spool in a fresh state
// directory, and a capture of that source into an in-memory Hub.
const setUp = async ({ chunkLimit }: { chunkLimit?: number } = {}) => {
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
      sources,
      spool,
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

  test('opens when bytes already uploaded change, never splicing two contents', async () => {
    await using t = await setUp();
    const c = t.capture();
    await t.write(SESSION, '{"a":1}\n');
    await t.tick(c);
    await t.write(SESSION, '{"A":1}\n{"b":2}\n');
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
