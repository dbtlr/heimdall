import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import { startHub } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { unreachableHub } from '../testing/fake-hub.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { createCapture } from './capture.ts';
import { transcriptHub } from './hub-client.ts';
import type { TranscriptHub } from './hub-client.ts';
import type { Source } from './sources.ts';
import { openSpool } from './spool.ts';

// These tests need PostgreSQL, like the Hub's own: CI's gate provides it, while
// the release build's per-platform test step has none and skips them.
const withPostgres = test.skipIf(
  process.env.HEIMDALL_TEST_DATABASE_URL === undefined && Bun.which('initdb') === null,
);

const gunzip = promisify(gunzipCallback);

// A test Hub on a fresh database, served over HTTP on a free loopback port.
const servedHub = async () => {
  const h = await startHub();
  const server = Bun.serve({ fetch: h.hub.fetch, hostname: '127.0.0.1', port: 0 });
  return {
    ...h,
    url: new URL(`http://127.0.0.1:${String(server.port)}/`),
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
      await h[Symbol.asyncDispose]();
    },
  };
};

// Every file the Hub holds for `system`, by source and path, each generation's
// content unpacked and joined in order.
const archive = async (h: Hub, system: string) => {
  const rows: { content: Buffer; generation: string; path: string; source: string }[] = await h.db
    .sql`
    SELECT g.id::text AS generation, g.source, g.path, c.content
    FROM transcript_generations g JOIN transcript_chunks c ON c.generation = g.id
    WHERE g.system = ${system}
    ORDER BY g.id, c.offset_bytes
  `;
  const files = new Map<string, Buffer[]>();
  for (const row of rows) {
    const key = `${row.source}/${row.path}#${row.generation}`;
    // oxlint-disable-next-line no-await-in-loop -- rows unpack in order.
    files.set(key, [...(files.get(key) ?? []), await gunzip(row.content)]);
  }
  return Object.fromEntries(
    [...files].map(([key, parts]) => [
      key.replace(/#\d+$/u, ''),
      Buffer.concat(parts).toString('utf8'),
    ]),
  );
};

const setUp = async () => {
  const root = await tempStateDir();
  const source: Source = {
    dir: join(root.path, 'claude'),
    harness: 'claude-code',
    name: 'claude-code',
    trees: ['projects'],
  };
  const spool = await openSpool({ stateDir: join(root.path, 'state') });
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(source.dir, path)), { recursive: true });
    await writeFile(join(source.dir, path), content);
  };
  const capture = (hub: TranscriptHub) =>
    createCapture({ hub, log: { warn: () => {} }, now: Date.now, sources: [source], spool });
  return {
    capture,
    source,
    write,
    [Symbol.asyncDispose]: async () => {
      spool.close();
      await root[Symbol.asyncDispose]();
    },
  };
};

withPostgres(
  "a Claude Code session tree reaches a real Hub as written, under the System's token",
  async () => {
    await using h = await servedHub();
    await using t = await setUp();
    const main = `${'{"type":"user","message":"hello"}\n'.repeat(40_000)}{"type":"assistant"}\n`;
    await t.write('projects/my-project/0b1c.jsonl', main);
    await t.write('projects/my-project/0b1c/subagents/agent-1.jsonl', '{"agent":1}\n');
    await t.write('projects/my-project/0b1c/tool-results/r1.txt', 'large output');
    const c = t.capture(transcriptHub({ hub: h.url, token: 'laptop-token' }));

    // The tool result uploads only once it has held still across two scans.
    for (let scan = 0; scan < 2; scan += 1) {
      // oxlint-disable-next-line no-await-in-loop -- scans are sequential.
      await c.scan();
      // oxlint-disable-next-line no-await-in-loop -- drains are sequential.
      expect(await c.drain()).toEqual({ kind: 'drained' });
    }

    expect(await archive(h, 'laptop-1')).toEqual({
      'claude-code/projects/my-project/0b1c.jsonl': main,
      'claude-code/projects/my-project/0b1c/subagents/agent-1.jsonl': '{"agent":1}\n',
      'claude-code/projects/my-project/0b1c/tool-results/r1.txt': 'large output',
    });
    expect(h.errors).toEqual([]);
  },
);

withPostgres(
  'a transcript spooled while the Hub was unreachable reaches it after the Harness deleted it',
  async () => {
    await using h = await servedHub();
    await using t = await setUp();
    await t.write('projects/p/s.jsonl', '{"a":1}\n');
    const offline = t.capture(transcriptHub({ hub: new URL(unreachableHub()), token: 'x' }));
    await offline.scan();

    expect((await offline.drain()).kind).toBe('failed');

    await rm(join(t.source.dir, 'projects/p/s.jsonl'));
    const online = t.capture(transcriptHub({ hub: h.url, token: 'laptop-token' }));

    expect(await online.drain()).toEqual({ kind: 'drained' });
    expect(await archive(h, 'laptop-1')).toEqual({ 'claude-code/projects/p/s.jsonl': '{"a":1}\n' });
    expect(online.section().spool).toEqual({ bytes: 0, oldestAt: null });
  },
);
