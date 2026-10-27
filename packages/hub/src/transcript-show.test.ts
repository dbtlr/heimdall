import { beforeAll, describe, expect, test } from 'bun:test';

import type { Host } from '@loomcli/core';

import { claudeCodeParser } from './claude-code-parser.ts';
import { projectTranscripts } from './projection.ts';
import { MAX_LINE_BYTES } from './session-insight.ts';
import { agentPath, assistant, jsonl, mainPath, SESSION, user } from './testing/claude-code.ts';
import { configArgs, hubConfig, invoke } from './testing/cli.ts';
import { gzip } from './testing/hub.ts';
import { migratedDatabase, startTestServer, testDatabase } from './testing/postgres.ts';
import { writeHeldLines, writeRequestLines } from './transcript-reader.ts';
import { appendChunk, deleteTranscripts, openGeneration } from './transcripts.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

const NOW = Date.UTC(2026, 9, 6, 12);
const at = (second: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, second)).toISOString();

// A main conversation whose first response spans two lines, as Claude Code
// writes one line per content block, and a subagent it spawned.
const MAIN_LINES = [
  user({ at: at(0) }),
  assistant({ at: at(1), block: { kind: 'thinking' }, id: 'msg_a', stop: null }),
  assistant({ at: at(2), id: 'msg_a', usage: { input: 3, output: 5 } }),
  user({ at: at(3) }),
];
const MAIN = jsonl(MAIN_LINES);
const SUBAGENT = jsonl([user({ agent: 's1', at: at(4) })]);

const NOT_A_TERMINAL: Host['terminal'] = {
  stderr: { columns: undefined, isTTY: false, rows: undefined },
  stdin: { isTTY: false },
  stdout: { columns: undefined, isTTY: false, rows: undefined },
};
const A_TERMINAL: Host['terminal'] = {
  ...NOT_A_TERMINAL,
  stdout: { columns: 80, isTTY: true, rows: 24 },
};

type Db = Awaited<ReturnType<typeof testDatabase>>;

// Stores `content` at `path` of laptop-1's claude-code source, one line per
// chunk as a Collector might send it, and answers its generation.
const store = async (db: Db, path: string, content: string | Uint8Array) => {
  const opened = await openGeneration(db.sql, {
    now: NOW,
    path,
    source: 'claude-code',
    system: 'laptop-1',
  });
  if (opened.kind !== 'opened') {
    throw new Error(`Could not open ${path}.`);
  }
  let offset = 0;
  const lines = typeof content === 'string' ? content.split(/(?<=\n)/u) : [content];
  for (const line of lines) {
    const length = typeof line === 'string' ? Buffer.byteLength(line) : line.byteLength;
    // oxlint-disable-next-line no-await-in-loop -- chunks go in order, as the Collector sends them.
    const packed = await gzip(line);
    // oxlint-disable-next-line no-await-in-loop -- chunks go in order, as the Collector sends them.
    await appendChunk(db.sql, {
      content: packed,
      generation: opened.generation,
      length,
      now: NOW,
      offset,
      system: 'laptop-1',
    });
    offset += length;
  }
  return opened.generation;
};

// A database holding a projected Session with one subagent, and the Hub's
// configuration file for it. `rewritten` is stored as a later generation of
// the main transcript, as when the file was replaced. `deleted` is stored as
// one more, which is marked deleted after it is projected, as when the Hub
// deletes a System's transcripts before the next projection.
const archive = async ({ deleted, rewritten }: { deleted?: string; rewritten?: string } = {}) => {
  const db = await migratedDatabase();
  const main = await store(db, mainPath(), MAIN);
  await store(db, agentPath('s1'), SUBAGENT);
  if (rewritten !== undefined) {
    await store(db, mainPath(), rewritten);
  }
  const doomed = deleted === undefined ? undefined : await store(db, mainPath(), deleted);
  await db.sql`
    INSERT INTO transcript_source_harnesses (system, source, harness, sent_at)
    VALUES ('laptop-1', 'claude-code', 'claude-code', now())
  `;
  await projectTranscripts(db.sql);
  if (doomed !== undefined) {
    await db.sql`UPDATE transcript_generations SET deleted_at = now() WHERE id = ${doomed}::bigint`;
  }
  const config = await hubConfig(db);
  return {
    config,
    db,
    main,
    [Symbol.asyncDispose]: async () => {
      await config[Symbol.asyncDispose]();
      await db[Symbol.asyncDispose]();
    },
  };
};

const show = (config: { path: string }, args: string[], terminal = NOT_A_TERMINAL) =>
  invoke(['transcripts', 'show', ...args, ...configArgs(config)], { terminal });

// The lines `bytes` holds, each with its newline, in order.
const linesIn = (bytes: Buffer) =>
  bytes
    .toString()
    .split(/(?<=\n)/u)
    .filter((line) => line !== '');

describe('transcripts show', () => {
  test('by request prints every line of that request, and only those', async () => {
    await using a = await archive();

    const { bytes, code, stderr } = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--request',
      'msg_a',
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(bytes.toString()).toBe(jsonl([MAIN_LINES[1], MAIN_LINES[2]]));
  });

  test('by request prints a line another generation holds too, and each line once', async () => {
    const extra = assistant({ at: at(1), block: { kind: 'text' }, id: 'msg_a', stop: null });
    await using a = await archive({
      rewritten: jsonl([MAIN_LINES[0], MAIN_LINES[1], extra, MAIN_LINES[2], MAIN_LINES[3]]),
    });

    const { bytes, code } = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--request',
      'msg_a',
    ]);

    expect(code).toBe(0);
    expect(linesIn(bytes).toSorted()).toEqual(
      linesIn(Buffer.from(jsonl([MAIN_LINES[1], MAIN_LINES[2], extra]))).toSorted(),
    );
  });

  test("by request leaves out another request's lines, and a deleted generation's", async () => {
    const other = assistant({ at: at(1), id: 'msg_b', usage: { input: 7, output: 9 } });
    const onlyDeleted = assistant({ at: at(1), block: { kind: 'text' }, id: 'msg_a', stop: null });
    await using a = await archive({
      deleted: jsonl([MAIN_LINES[0], MAIN_LINES[1], onlyDeleted, MAIN_LINES[2]]),
      rewritten: jsonl([MAIN_LINES[0], MAIN_LINES[1], other, MAIN_LINES[2], MAIN_LINES[3]]),
    });

    const { bytes, code } = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--request',
      'msg_a',
    ]);

    expect(code).toBe(0);
    expect(linesIn(bytes).toSorted()).toEqual(
      linesIn(Buffer.from(jsonl([MAIN_LINES[1], MAIN_LINES[2]]))).toSorted(),
    );
  });

  test('a request the views do not hold exits non-zero and says so', async () => {
    await using a = await archive();

    const { bytes, code, stderr } = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--request',
      'msg_nope',
    ]);

    expect(stderr).toContain('No request msg_nope of claude-code on laptop-1');
    expect(bytes.byteLength).toBe(0);
    expect(code).toBe(1);
  });

  test("by a request's locator prints exactly the line it was read from", async () => {
    await using a = await archive();
    const [request] = await a.db.sql`
      SELECT system, source, path, generation, byte_offset FROM insight.requests
      WHERE request_id = 'msg_a'
    `;
    if (request === undefined) {
      throw new Error('The request was not projected.');
    }

    const { bytes, code, stderr } = await show(a.config, [
      '--system',
      request.system,
      '--source',
      request.source,
      '--path',
      request.path,
      '--generation',
      request.generation,
      '--offset',
      request.byte_offset,
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(bytes.toString()).toBe(jsonl([MAIN_LINES[2]]));
  });

  test("by Session prints its main conversation's lines as the Hub holds them", async () => {
    await using a = await archive();

    const { bytes, code } = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--session',
      SESSION,
    ]);

    expect(code).toBe(0);
    expect(bytes.toString()).toBe(MAIN);
  });

  test("with --agent prints that subagent's lines", async () => {
    await using a = await archive();

    const { bytes, code } = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--session',
      SESSION,
      '--agent',
      's1',
    ]);

    expect(code).toBe(0);
    expect(bytes.toString()).toBe(SUBAGENT);
  });

  test('by generation alone prints the whole generation', async () => {
    await using a = await archive();

    const { bytes } = await show(a.config, ['--generation', String(a.main)]);

    expect(bytes.toString()).toBe(MAIN);
  });

  test('an unknown generation exits non-zero, says so, and prints nothing to stdout', async () => {
    await using db = await testDatabase();
    await using config = await hubConfig(db);

    const { bytes, code, stderr } = await show(config, ['--generation', '42']);

    expect(stderr).toContain('No generation 42.');
    expect(bytes.byteLength).toBe(0);
    expect(code).toBe(1);
  });

  test("a locator whose System, source, or path is not its generation's is unknown", async () => {
    await using a = await archive();

    for (const filter of [
      ['--system', 'server-1'],
      ['--source', 'codex'],
      ['--path', 'projects/elsewhere.jsonl'],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one locator at a time.
      const { bytes, code, stderr } = await show(a.config, [
        ...filter,
        '--generation',
        String(a.main),
        '--offset',
        '0',
      ]);
      expect([filter, stderr.includes(`No generation ${String(a.main)} `), code]).toEqual([
        filter,
        true,
        1,
      ]);
      expect(bytes.byteLength).toBe(0);
    }
  });

  test('a deleted generation exits non-zero and says it was deleted', async () => {
    await using a = await archive();
    await deleteTranscripts(a.db.sql, { dryRun: false, now: NOW, system: 'laptop-1' });

    const { code, stderr } = await show(a.config, ['--generation', String(a.main)]);

    expect(stderr).toContain(`Generation ${String(a.main)} was deleted.`);
    expect(code).toBe(1);
  });

  test('a Session the views do not hold exits non-zero and says so', async () => {
    await using a = await archive();

    const { code, stderr } = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--session',
      'no-such-session',
    ]);

    expect(stderr).toContain('No Session no-such-session of claude-code on laptop-1');
    expect(code).toBe(1);
  });

  test('an offset inside a line, or past the end, exits non-zero and says so', async () => {
    await using a = await archive();
    const generation = String(a.main);

    const inside = await show(a.config, ['--generation', generation, '--offset', '1']);
    const past = await show(a.config, [
      '--generation',
      generation,
      '--offset',
      String(Buffer.byteLength(MAIN)),
    ]);

    expect(inside.stderr).toContain(`Byte 1 of generation ${generation} does not start a line.`);
    expect(inside.code).toBe(1);
    expect(past.stderr).toContain('past its end');
    expect(past.code).toBe(1);
  });

  test('names what to show, and a Session with its System and source', async () => {
    await using a = await archive();

    const nothing = await show(a.config, []);
    const bare = await show(a.config, ['--session', SESSION]);
    const both = await show(a.config, [
      '--system',
      'laptop-1',
      '--source',
      'claude-code',
      '--session',
      SESSION,
      '--generation',
      String(a.main),
    ]);

    expect(nothing.stderr).toContain('--session');
    expect(nothing.code).not.toBe(0);
    expect(bare.stderr).toContain('--system and --source');
    expect(bare.code).not.toBe(0);
    expect(both.stderr).toContain('only one');
    expect(both.code).not.toBe(0);
  });

  test('on a terminal escapes control characters, and piped writes the bytes as held', async () => {
    await using a = await archive();
    const content = 'plain \u001b[31mred\u001b[0m\n';
    const generation = String(await store(a.db, 'projects/p/tool-results/out.txt', content));

    const piped = await show(a.config, ['--generation', generation]);
    const shown = await show(a.config, ['--generation', generation], A_TERMINAL);

    expect(piped.bytes.toString()).toBe(content);
    expect(shown.stdout).toBe('plain \\u001b[31mred\\u001b[0m\n');
  });

  test('on a terminal shows a sequence the generation ends inside as a replacement character', async () => {
    await using a = await archive();
    // The first byte of `é` and none of the second.
    const content = new Uint8Array([...Buffer.from('a\n'), Buffer.from('é')[0] ?? 0]);
    const generation = String(await store(a.db, 'projects/p/tool-results/cut.txt', content));

    const shown = await show(a.config, ['--generation', generation], A_TERMINAL);

    expect(shown.stdout).toBe('a\n\uFFFD');
  });
});

describe('writeHeldLines', () => {
  // A window smaller than a line, so every read stops inside one.
  const windowBytes = 7;

  test('writes from the offset to the end, a window at a time', async () => {
    await using db = await migratedDatabase();
    const generation = await store(db, mainPath(), MAIN);
    const held = Buffer.byteLength(MAIN);
    const written: Uint8Array[] = [];

    await writeHeldLines(
      db.sql,
      { from: 0, generation, held, oneLine: false, windowBytes },
      async (bytes) => {
        written.push(bytes);
      },
    );

    expect(Buffer.concat(written).toString()).toBe(MAIN);
  });

  test('with oneLine writes the line at the offset and stops after its newline', async () => {
    await using db = await migratedDatabase();
    const generation = await store(db, mainPath(), MAIN);
    const from = Buffer.byteLength(jsonl(MAIN_LINES.slice(0, 1)));
    const written: Uint8Array[] = [];

    await writeHeldLines(
      db.sql,
      { from, generation, held: Buffer.byteLength(MAIN), oneLine: true, windowBytes },
      async (bytes) => {
        written.push(bytes);
      },
    );

    expect(Buffer.concat(written).toString()).toBe(jsonl([MAIN_LINES[1]]));
  });
});

describe('writeRequestLines', () => {
  test("writes a request's lines a window smaller than a line at a time, the last line without its newline too", async () => {
    await using db = await migratedDatabase();
    const last = JSON.stringify(assistant({ at: at(5), id: 'msg_a' }));
    const content = MAIN + last;
    const generation = await store(db, mainPath(), content);
    const written: Uint8Array[] = [];

    await writeRequestLines(
      db.sql,
      {
        generations: [{ generation, held: Buffer.byteLength(content) }],
        request: 'msg_a',
        requestIdOf: claudeCodeParser.requestIdOf,
        windowBytes: 7,
      },
      async (bytes) => {
        written.push(bytes);
      },
    );

    expect(Buffer.concat(written).toString()).toBe(jsonl([MAIN_LINES[1], MAIN_LINES[2]]) + last);
  });

  test('skips a line longer than the parsers read, though no window held all of it', async () => {
    await using db = await migratedDatabase();
    const line = JSON.stringify({ ...assistant({ at: at(1), id: 'msg_a' }), pad: '' });
    // One byte over the limit, read in windows of half the limit: the first two
    // windows hold the limit exactly, and the third ends the line.
    const long = `${line.slice(0, -2)}${'a'.repeat(MAX_LINE_BYTES + 1 - line.length)}"}`;
    const content = `${long}\n${jsonl([MAIN_LINES[2]])}`;
    const generation = await store(db, mainPath(), content);
    const written: Uint8Array[] = [];

    await writeRequestLines(
      db.sql,
      {
        generations: [{ generation, held: Buffer.byteLength(content) }],
        request: 'msg_a',
        requestIdOf: claudeCodeParser.requestIdOf,
        windowBytes: MAX_LINE_BYTES / 2,
      },
      async (bytes) => {
        written.push(bytes);
      },
    );

    expect(Buffer.byteLength(long)).toBe(MAX_LINE_BYTES + 1);
    expect(Buffer.concat(written).toString()).toBe(jsonl([MAIN_LINES[2]]));
  });
});
