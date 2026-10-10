import { describe, expect, test } from 'bun:test';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import { MAX_TRANSCRIPT_CHUNK_BYTES, MAX_TRANSCRIPT_REQUEST_BYTES } from '@heimdall/schema';
import type { SQL } from 'bun';

import { listSystems, storeReport } from './store.ts';
import { NOW, gzip, openGeneration, push, report, sendChunk, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import {
  deleteTranscripts,
  openGeneration as openStored,
  randomGenerationId,
} from './transcripts.ts';

const FILE = { path: 'my-project/0b1c.jsonl', source: 'claude-code' };

const LINE_1 = '{"type":"user","message":"hello"}\n';
const LINE_2 = '{"type":"assistant","message":"hi"}\n';

// Opens a generation for `file` as `token`'s System and answers its identifier.
const open = async (h: Hub, file = FILE, token = 'laptop-token') => {
  const response = await openGeneration(h.hub, file, { token });
  expect(response.status).toBe(201);
  return ((await response.json()) as { generation: number }).generation;
};

// The content the Hub holds for a generation, unpacked and joined in order.
const gunzip = promisify(gunzipCallback);

const held = async (sql: SQL, generation: number) => {
  const rows: { content: Buffer }[] = await sql`
    SELECT content FROM transcript_chunks WHERE generation = ${generation} ORDER BY offset_bytes
  `;
  const unpacked = await Promise.all(rows.map((row) => gunzip(row.content)));
  return Buffer.concat(unpacked).toString('utf8');
};

// Waits until `count` backends of this database wait on a lock.
const waitersOnLocks = async (sql: SQL, count: number) => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polls until the waiters queue.
    const [row]: { n: number }[] = await sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if ((row?.n ?? 0) >= count) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until the waiters queue.
    await Bun.sleep(10);
  }
};

const openConditions = async (sql: SQL) =>
  sql`SELECT kind FROM conditions WHERE cleared_at IS NULL` as Promise<unknown[]>;

describe('opening a generation', () => {
  test('without a token is refused as unauthenticated', async () => {
    await using h = await startHub();

    expect((await openGeneration(h.hub, FILE)).status).toBe(401);
  });

  test('with a token no System holds is forbidden', async () => {
    await using h = await startHub();

    expect((await openGeneration(h.hub, FILE, { token: 'guess' })).status).toBe(403);
  });

  test('answers a new generation that holds nothing', async () => {
    await using h = await startHub();

    const response = await openGeneration(h.hub, FILE, { token: 'laptop-token' });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ generation: expect.any(Number), held: 0 });
  });

  // A file that shrank or was replaced starts a new generation, never
  // appending to the old one (ADR-0013).
  // A path of the longest the schema allows, in characters that do not
  // compress, outgrows a plain index entry. 19,968 is U+4E00, the first CJK ideograph.
  test('at the longest path the schema allows opens', async () => {
    await using h = await startHub();
    const path = Array.from({ length: 1365 }, (_, i) => String.fromCodePoint(19_968 + i)).join('');

    const response = await openGeneration(h.hub, { ...FILE, path }, { token: 'laptop-token' });

    expect(response.status).toBe(201);
    expect(h.errors).toEqual([]);
  });

  test('again at the same path opens another generation', async () => {
    await using h = await startHub();

    expect(await open(h)).not.toBe(await open(h));
  });

  // A restore puts the database, sequences included, back as the backup had
  // it, while Collectors still hold the ids the Hub answered since. A
  // reissued generation id would splice two files (ADR-0013).
  test('after a restore from an earlier backup never reissues an id it issued since', async () => {
    await using h = await startHub();
    const before = await open(h);
    const since = await Promise.all(Array.from({ length: 20 }, async () => open(h)));
    await h.db.sql`DELETE FROM transcript_generations WHERE id <> ${before}`;
    await h.db.sql`SELECT setval(pg_get_serial_sequence('transcript_generations', 'id'), 1)`;

    const after = await Promise.all(Array.from({ length: 20 }, async () => open(h)));

    expect(after.filter((generation) => since.includes(generation))).toEqual([]);
    expect(after.every((generation) => Number.isSafeInteger(generation) && generation > 0)).toBe(
      true,
    );
  });

  test('draws another id when the one it drew is taken', async () => {
    await using h = await startHub();
    const taken = await open(h);
    const drawn = [taken, 42];
    const file = { ...FILE, now: NOW, system: 'laptop-1' };

    const opened = await openStored(h.db.sql, { ...file, newId: () => drawn.shift() ?? 0 });

    expect(opened).toEqual({ generation: 42, kind: 'opened' });
  });

  test.each([
    ['not JSON', '{'],
    ['a path that climbs out of the source', { ...FILE, path: '../secrets' }],
    ['no source', { path: FILE.path }],
  ])('with a body that is %s is refused as invalid', async (_, body) => {
    await using h = await startHub();

    expect((await openGeneration(h.hub, body, { token: 'laptop-token' })).status).toBe(422);
  });
});

describe('a chunk', () => {
  test('at the offset the Hub holds is stored as uploaded and acknowledged', async () => {
    await using h = await startHub();
    const generation = await open(h);
    const gzipped = await gzip(LINE_1);

    const first = await sendChunk(h.hub, generation, {
      content: gzipped,
      offset: 0,
      token: 'laptop-token',
    });
    const second = await sendChunk(h.hub, generation, {
      content: LINE_2,
      offset: LINE_1.length,
      token: 'laptop-token',
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ held: LINE_1.length });
    expect(await second.json()).toEqual({ held: LINE_1.length + LINE_2.length });
    expect(await held(h.db.sql, generation)).toBe(LINE_1 + LINE_2);
    const [stored] = await h.db.sql`
      SELECT content FROM transcript_chunks WHERE generation = ${generation} AND offset_bytes = 0
    `;
    expect(new Uint8Array((stored as { content: Uint8Array }).content)).toEqual(gzipped);
  });

  test('at an offset past what the Hub holds is answered with what it holds', async () => {
    await using h = await startHub();
    const generation = await open(h);

    const response = await sendChunk(h.hub, generation, {
      content: LINE_2,
      offset: LINE_1.length,
      token: 'laptop-token',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ held: 0 });
    expect(await held(h.db.sql, generation)).toBe('');
  });

  test('the Hub already holds is accepted again without effect', async () => {
    await using h = await startHub();
    const generation = await open(h);
    await sendChunk(h.hub, generation, { content: LINE_1, offset: 0, token: 'laptop-token' });
    await sendChunk(h.hub, generation, {
      content: LINE_2,
      offset: LINE_1.length,
      token: 'laptop-token',
    });

    const resent = await sendChunk(h.hub, generation, {
      content: LINE_1,
      offset: 0,
      token: 'laptop-token',
    });

    expect(resent.status).toBe(200);
    expect(await resent.json()).toEqual({ held: LINE_1.length + LINE_2.length });
    expect(await held(h.db.sql, generation)).toBe(LINE_1 + LINE_2);
  });

  test('that overlaps the end of what the Hub holds is answered with what it holds', async () => {
    await using h = await startHub();
    const generation = await open(h);
    await sendChunk(h.hub, generation, { content: LINE_1, offset: 0, token: 'laptop-token' });

    const response = await sendChunk(h.hub, generation, {
      content: LINE_1 + LINE_2,
      offset: 0,
      token: 'laptop-token',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ held: LINE_1.length });
  });

  // Two deliveries of one chunk race when the Collector retries a request
  // whose answer it lost.
  test('sent twice at once is stored once', async () => {
    await using h = await startHub();
    const generation = await open(h);
    const send = () =>
      sendChunk(h.hub, generation, { content: LINE_1, offset: 0, token: 'laptop-token' });

    const answers = await Promise.all([send(), send()]);

    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(await held(h.db.sql, generation)).toBe(LINE_1);
  });

  test('that is empty holds nothing more, and the next chunk follows it', async () => {
    await using h = await startHub();
    const generation = await open(h);

    const empty = await sendChunk(h.hub, generation, {
      content: '',
      offset: 0,
      token: 'laptop-token',
    });
    const next = await sendChunk(h.hub, generation, {
      content: LINE_1,
      offset: 0,
      token: 'laptop-token',
    });

    expect(await empty.json()).toEqual({ held: 0 });
    expect(await next.json()).toEqual({ held: LINE_1.length });
  });

  test('counts bytes of the file, not of the gzipped body', async () => {
    await using h = await startHub();
    const generation = await open(h);
    const content = 'é'.repeat(1000);

    const response = await sendChunk(h.hub, generation, {
      content,
      offset: 0,
      token: 'laptop-token',
    });

    expect(await response.json()).toEqual({ held: Buffer.byteLength(content) });
  });

  test('for a generation another System opened is not found', async () => {
    await using h = await startHub();
    const generation = await open(h, FILE, 'server-token');

    const response = await sendChunk(h.hub, generation, {
      content: LINE_1,
      offset: 0,
      token: 'laptop-token',
    });

    expect(response.status).toBe(404);
    expect(await held(h.db.sql, generation)).toBe('');
  });

  test.each([
    ['an unknown generation', 999_999],
    ['a generation that is not a number', 'x'],
  ])('for %s is not found', async (_, generation) => {
    await using h = await startHub();

    const response = await sendChunk(h.hub, generation, {
      content: LINE_1,
      offset: 0,
      token: 'laptop-token',
    });

    expect(response.status).toBe(404);
  });

  // 2^53 + 1 reads as the Number 2^53, so it must not reach that generation.
  test('for an id past the largest safe integer is not found', async () => {
    await using h = await startHub();
    const file = { ...FILE, now: NOW, system: 'laptop-1' };
    await openStored(h.db.sql, { ...file, newId: () => 2 ** 53 });

    const response = await sendChunk(h.hub, '9007199254740993', {
      content: LINE_1,
      offset: 0,
      token: 'laptop-token',
    });

    expect(response.status).toBe(404);
  });

  test('without a token is refused as unauthenticated', async () => {
    await using h = await startHub();
    const generation = await open(h);

    expect((await sendChunk(h.hub, generation, { content: LINE_1, offset: 0 })).status).toBe(401);
  });

  test.each([
    ['no offset', { content: LINE_1 }],
    ['a negative offset', { content: LINE_1, offset: '-1' }],
    ['a fractional offset', { content: LINE_1, offset: '1.5' }],
    ['an offset past safe integers', { content: LINE_1, offset: '9007199254740992' }],
    ['a body that is not gzip', { content: new TextEncoder().encode(LINE_1), offset: 0 }],
    [
      'a body that unpacks past the chunk limit',
      { content: 'x'.repeat(MAX_TRANSCRIPT_CHUNK_BYTES + 1), offset: 0 },
    ],
  ])('with %s is refused as invalid', async (_, chunk) => {
    await using h = await startHub();
    const generation = await open(h);

    const response = await sendChunk(h.hub, generation, { ...chunk, token: 'laptop-token' });

    expect(response.status).toBe(422);
  });

  test('with a body past the request cap is refused as too large', async () => {
    await using h = await startHub();
    const generation = await open(h);

    const response = await sendChunk(h.hub, generation, {
      content: new Uint8Array(MAX_TRANSCRIPT_REQUEST_BYTES + 1),
      offset: 0,
      token: 'laptop-token',
    });

    expect(response.status).toBe(413);
  });
});

describe('an upload', () => {
  test('counts toward Last seen, even from a System that has sent no Report', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 60_000;

    await open(h);

    expect(await listSystems(h.db.sql)).toMatchObject([
      { lastSeenAt: NOW + 60_000, name: 'laptop-1' },
    ]);
  });

  test('that is refused counts toward Last seen', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 60_000;

    await openGeneration(h.hub, '{', { token: 'laptop-token' });

    expect(await listSystems(h.db.sql)).toMatchObject([{ lastSeenAt: NOW + 60_000 }]);
  });

  // A delete holding a generation must not hold up the System's Reports.
  test("waiting on its generation does not hold up its System's Reports", async () => {
    await using h = await startHub();
    const generation = await open(h);
    let chunk: Promise<Response> | undefined;

    await h.db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM transcript_generations WHERE id = ${generation} FOR UPDATE`;
      chunk = sendChunk(h.hub, generation, { content: LINE_1, offset: 0, token: 'laptop-token' });
      await waitersOnLocks(h.db.sql, 1);

      const stored = await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

      expect(stored.status).toBe(200);
    });
    expect((await chunk)?.status).toBe(200);
  });

  test('that is refused raises no Condition', async () => {
    await using h = await startHub();
    const generation = await open(h);

    await openGeneration(h.hub, '{', { token: 'laptop-token' });
    await sendChunk(h.hub, generation, { content: LINE_1, offset: 5, token: 'laptop-token' });
    await sendChunk(h.hub, generation, { content: LINE_1, token: 'laptop-token' });

    expect(await openConditions(h.db.sql)).toEqual([]);
  });
});

// Fills a generation for `file` with one line, uploaded at `at`.
const upload = async (h: Hub, at: number, file = FILE, token = 'laptop-token') => {
  h.clock.now = at;
  const generation = await open(h, file, token);
  await sendChunk(h.hub, generation, { content: LINE_1, offset: 0, token });
  return generation;
};

const generations = async (sql: SQL) => {
  const rows: { id: string }[] = await sql`
    SELECT g.id FROM transcript_generations g
    WHERE EXISTS (SELECT 1 FROM transcript_chunks c WHERE c.generation = g.id)
    ORDER BY g.id
  `;
  return rows.map((row) => Number(row.id));
};

describe('deleting transcripts', () => {
  test("removes a System's generations, whole, and reports what it removed", async () => {
    await using h = await startHub();
    const laptop = await upload(h, NOW);
    const server = await upload(h, NOW, FILE, 'server-token');

    const removed = await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });

    expect(removed).toEqual({ bytes: expect.any(Number), generations: 1 });
    expect(removed.bytes).toBeGreaterThan(0);
    expect(await generations(h.db.sql)).toEqual([server]);
    expect(laptop).not.toBe(server);
  });

  test("removes a source's generations on every System", async () => {
    await using h = await startHub();
    await upload(h, NOW);
    await upload(h, NOW, FILE, 'server-token');
    const codex = await upload(h, NOW, { path: 'a.jsonl', source: 'codex' });

    await deleteTranscripts(h.db.sql, { now: NOW, source: 'claude-code' });

    expect(await generations(h.db.sql)).toEqual([codex]);
  });

  // A file still growing is never cut (ADR-0013).
  test('before a date removes only generations last uploaded before it', async () => {
    await using h = await startHub();
    const old = await upload(h, NOW - 2 * 86_400_000);
    const growing = await upload(h, NOW - 2 * 86_400_000, { ...FILE, path: 'b.jsonl' });
    h.clock.now = NOW;
    await sendChunk(h.hub, growing, {
      content: LINE_2,
      offset: LINE_1.length,
      token: 'laptop-token',
    });

    await deleteTranscripts(h.db.sql, { before: NOW - 86_400_000, now: NOW });

    expect(await generations(h.db.sql)).toEqual([growing]);
    expect(await held(h.db.sql, growing)).toBe(LINE_1 + LINE_2);
    expect(old).not.toBe(growing);
  });

  test('combines its filters', async () => {
    await using h = await startHub();
    await upload(h, NOW);
    const codex = await upload(h, NOW, { path: 'a.jsonl', source: 'codex' });
    const server = await upload(h, NOW, FILE, 'server-token');

    await deleteTranscripts(h.db.sql, { now: NOW, source: 'claude-code', system: 'laptop-1' });

    expect(await generations(h.db.sql)).toEqual([codex, server].toSorted((x, y) => x - y));
  });

  test('as a dry run removes nothing and reports what it would remove', async () => {
    await using h = await startHub();
    const generation = await upload(h, NOW);

    const removed = await deleteTranscripts(h.db.sql, {
      dryRun: true,
      now: NOW,
      system: 'laptop-1',
    });

    expect(removed.generations).toBe(1);
    expect(await generations(h.db.sql)).toEqual([generation]);
    expect((await openGeneration(h.hub, FILE, { token: 'laptop-token' })).status).toBe(201);
  });

  test('refuses a later generation at a path whose every generation it removed', async () => {
    await using h = await startHub();
    await upload(h, NOW);
    await upload(h, NOW);

    await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });
    const response = await openGeneration(h.hub, FILE, { token: 'laptop-token' });

    expect(response.status).toBe(410);
  });

  test('refuses further chunks of a generation it removed', async () => {
    await using h = await startHub();
    const generation = await upload(h, NOW);

    await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });
    const response = await sendChunk(h.hub, generation, {
      content: LINE_2,
      offset: LINE_1.length,
      token: 'laptop-token',
    });

    expect(response.status).toBe(410);
  });

  test('keeps uploading a path with a surviving generation', async () => {
    await using h = await startHub();
    await upload(h, NOW - 2 * 86_400_000);
    const surviving = await upload(h, NOW);

    await deleteTranscripts(h.db.sql, { before: NOW - 86_400_000, now: NOW });

    expect((await openGeneration(h.hub, FILE, { token: 'laptop-token' })).status).toBe(201);
    const response = await sendChunk(h.hub, surviving, {
      content: LINE_2,
      offset: LINE_1.length,
      token: 'laptop-token',
    });
    expect(response.status).toBe(200);
  });

  test('does not tell another System that a generation was deleted', async () => {
    await using h = await startHub();
    const generation = await upload(h, NOW);
    await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });

    const response = await sendChunk(h.hub, generation, {
      content: LINE_2,
      offset: LINE_1.length,
      token: 'server-token',
    });

    expect(response.status).toBe(404);
  });

  test('again counts nothing it deleted before', async () => {
    await using h = await startHub();
    await upload(h, NOW);
    await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });

    const again = await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });

    expect(again).toEqual({ bytes: 0, generations: 0 });
  });

  // A generation opened while the delete runs would otherwise survive it and
  // keep the path open for good.
  test('refuses a generation opened at the path while it runs', async () => {
    await using h = await startHub();
    const files = [FILE, { ...FILE, path: 'b.jsonl' }];
    const ids = [await upload(h, NOW, files[0]), await upload(h, NOW, files[1])];
    const first = (ids[0] ?? 0) < (ids[1] ?? 0) ? 0 : 1;
    let removed: Promise<unknown> | undefined;
    let opened: Promise<Response> | undefined;

    // The delete locks generations in id order, so holding the higher id
    // keeps it waiting there, holding the lower one.
    await h.db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM transcript_generations WHERE id = ${ids[1 - first]} FOR UPDATE`;
      removed = deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });
      await waitersOnLocks(h.db.sql, 1);
      opened = openGeneration(h.hub, files[first], { token: 'laptop-token' });
      await waitersOnLocks(h.db.sql, 2);
    });

    expect(await removed).toEqual({ bytes: expect.any(Number), generations: 2 });
    expect((await opened)?.status).toBe(410);
    const live = await h.db.sql`SELECT id FROM transcript_generations WHERE deleted_at IS NULL`;
    expect([...live]).toEqual([]);
  });

  // An open that locked the path's generations first commits a new one the
  // delete's first pass cannot see; a later pass deletes it.
  test('deletes a generation opened at the path just before it', async () => {
    await using h = await startHub();
    const first = await upload(h, NOW);
    let removed: Promise<unknown> | undefined;

    await h.db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM transcript_generations WHERE id = ${first} FOR UPDATE`;
      await tx`
        INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
        VALUES (${randomGenerationId()}, 'laptop-1', ${FILE.source}, ${FILE.path}, ${new Date(NOW)}, ${new Date(NOW)})
      `;
      removed = deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });
      await waitersOnLocks(h.db.sql, 1);
    });

    expect(await removed).toEqual({ bytes: expect.any(Number), generations: 2 });
    const live = await h.db.sql`SELECT id FROM transcript_generations WHERE deleted_at IS NULL`;
    expect([...live]).toEqual([]);
  });

  // PostgreSQL binds at most 65,535 parameters in one statement.
  test('removes more generations than a statement can take as parameters', async () => {
    await using h = await startHub();
    await upload(h, NOW);
    await h.db.sql`
      WITH opened AS (
        INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at, held)
        SELECT n, 'laptop-1', 'claude-code', 'many/' || n || '.jsonl', ${new Date(NOW)}, ${new Date(NOW)}, 1
        FROM generate_series(1, 70000) AS n
        RETURNING id
      )
      INSERT INTO transcript_chunks (generation, offset_bytes, length, content)
      SELECT id, 0, 1, '\\x00'::bytea FROM opened
    `;

    const removed = await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });

    expect(removed.generations).toBe(70_001);
    const [left] = await h.db.sql`SELECT count(*)::int AS n FROM transcript_chunks`;
    expect(left).toEqual({ n: 0 });
  });

  test('refuses to run without a filter', async () => {
    await using h = await startHub();

    const failure = await deleteTranscripts(h.db.sql, { now: NOW }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
  });
});

const section = (status: 'absent' | 'capturing', bytes: number) => ({
  sources: [{ harness: 'claude-code', name: 'claude-code', status }],
  spool: { bytes, oldestAt: bytes === 0 ? null : NOW - 60_000 },
});

const stored = async (sql: SQL) =>
  sql`
    SELECT system, sources, spool_bytes, spool_oldest_at FROM transcript_sources ORDER BY system
  ` as Promise<unknown[]>;

describe("a Report's transcripts section", () => {
  test("is stored as the System's whole set of sources", async () => {
    await using h = await startHub();

    await push(
      h.hub,
      { ...report('laptop-1', [NOW]), transcripts: section('capturing', 4096) },
      {
        token: 'laptop-token',
      },
    );

    expect(await stored(h.db.sql)).toEqual([
      {
        sources: section('capturing', 4096).sources,
        spool_bytes: '4096',
        spool_oldest_at: new Date(NOW - 60_000),
        system: 'laptop-1',
      },
    ]);
  });

  test('replaces the set a Report sent earlier', async () => {
    await using h = await startHub();
    const later = { ...report('laptop-1', [NOW + 15_000]), sentAt: NOW + 15_000 };
    await storeReport(h.db.sql, {
      receivedAt: NOW,
      report: { ...report('laptop-1', [NOW]), transcripts: section('capturing', 4096) },
    });

    await storeReport(h.db.sql, {
      receivedAt: NOW + 15_000,
      report: { ...later, transcripts: section('absent', 0) },
    });

    expect(await stored(h.db.sql)).toEqual([
      expect.objectContaining({
        sources: section('absent', 0).sources,
        spool_bytes: '0',
        spool_oldest_at: null,
      }),
    ]);
  });

  // A queued Report can arrive after a newer one; the newer set stands.
  test('from an older Report does not replace a newer one', async () => {
    await using h = await startHub();
    const later = { ...report('laptop-1', [NOW + 15_000]), sentAt: NOW + 15_000 };
    await storeReport(h.db.sql, {
      receivedAt: NOW + 15_000,
      report: { ...later, transcripts: section('absent', 0) },
    });

    await storeReport(h.db.sql, {
      receivedAt: NOW + 20_000,
      report: { ...report('laptop-1', [NOW]), transcripts: section('capturing', 4096) },
    });

    expect(await stored(h.db.sql)).toEqual([
      expect.objectContaining({ sources: section('absent', 0).sources }),
    ]);
  });

  test('from a Report sent later than the Hub clock reads is replaced by the next one received', async () => {
    await using h = await startHub();
    const farFuture = NOW + 10 * 365 * 24 * 60 * 60 * 1000;
    await storeReport(h.db.sql, {
      receivedAt: NOW,
      report: {
        ...report('laptop-1', [NOW]),
        sentAt: farFuture,
        transcripts: section('capturing', 4096),
      },
    });

    await storeReport(h.db.sql, {
      receivedAt: NOW + 15_000,
      report: {
        ...report('laptop-1', [NOW + 15_000]),
        sentAt: NOW + 15_000,
        transcripts: section('absent', 0),
      },
    });

    expect(await stored(h.db.sql)).toEqual([
      expect.objectContaining({ sources: section('absent', 0).sources }),
    ]);
  });

  test('from a Report sent at the same moment replaces it', async () => {
    await using h = await startHub();
    await storeReport(h.db.sql, {
      receivedAt: NOW,
      report: { ...report('laptop-1', [NOW]), transcripts: section('capturing', 4096) },
    });

    await storeReport(h.db.sql, {
      receivedAt: NOW + 15_000,
      report: { ...report('laptop-1', [NOW + 1]), transcripts: section('absent', 0) },
    });

    expect(await stored(h.db.sql)).toEqual([
      expect.objectContaining({ sources: section('absent', 0).sources }),
    ]);
  });

  test('left out keeps the set stored', async () => {
    await using h = await startHub();
    await storeReport(h.db.sql, {
      receivedAt: NOW,
      report: { ...report('laptop-1', [NOW]), transcripts: section('capturing', 4096) },
    });

    await storeReport(h.db.sql, {
      receivedAt: NOW + 15_000,
      report: { ...report('laptop-1', [NOW + 15_000]), sentAt: NOW + 15_000 },
    });

    expect(await stored(h.db.sql)).toEqual([expect.objectContaining({ spool_bytes: '4096' })]);
  });
});
