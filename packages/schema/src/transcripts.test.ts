import { describe, expect, test } from 'bun:test';

import { ReportSchema } from './report.ts';
import type { Report } from './report.ts';
import { sample } from './testing.ts';
import {
  MAX_TRANSCRIPT_CHUNK_BYTES,
  MAX_TRANSCRIPT_REQUEST_BYTES,
  OpenGenerationSchema,
} from './transcripts.ts';
import type { TranscriptsSection } from './transcripts.ts';

const report = (): Report => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
  samples: [sample(1_759_700_000_000)],
  schemaVersion: 1,
  sentAt: 1_759_700_030_000,
  system: 'laptop-1',
});

const transcripts: TranscriptsSection = {
  sources: [
    { harness: 'claude-code', name: 'claude-code', status: 'capturing' },
    { harness: 'codex', name: 'codex', status: 'absent' },
  ],
  spool: { bytes: 4096, oldestAt: 1_759_700_000_000 },
};

// gzip can grow incompressible content slightly, so a full chunk still fits
// under the Hub's cap (ADR-0013).
test('a full chunk, gzipped at its worst, fits under the request cap', () => {
  const incompressible = crypto.getRandomValues(new Uint8Array(MAX_TRANSCRIPT_CHUNK_BYTES));

  expect(Bun.gzipSync(incompressible).byteLength).toBeLessThan(MAX_TRANSCRIPT_REQUEST_BYTES);
});

describe('opening a generation', () => {
  test.each([
    ['a Claude Code transcript', 'my-project/0b1c.jsonl'],
    ['a Codex rollout', '2026/10/09/rollout-2026-10-09T10-00-00-0b1c.jsonl'],
    ['a file with spaces and Unicode', 'café project/tool results/out 1.txt'],
  ])('accepts %s', (_, path) => {
    expect(OpenGenerationSchema.safeParse({ path, source: 'claude-code' }).success).toBe(true);
  });

  test.each([
    ['an absolute path', '/home/user/.claude/projects/a.jsonl'],
    ['a path that climbs out of the source', 'projects/../../secrets'],
    ['a path through the current directory', './a.jsonl'],
    ['an empty segment', 'projects//a.jsonl'],
    ['a trailing slash', 'projects/'],
    ['an empty path', ''],
    ['a NUL', 'a\0.jsonl'],
    ['a lone surrogate', 'a\uD800.jsonl'],
    ['a path longer than 4096 characters', 'a'.repeat(4097)],
  ])('refuses %s', (_, path) => {
    expect(OpenGenerationSchema.safeParse({ path, source: 'claude-code' }).success).toBe(false);
  });

  test('refuses a source name outside the naming rule', () => {
    expect(OpenGenerationSchema.safeParse({ path: 'a.jsonl', source: 'Claude Code' }).success).toBe(
      false,
    );
  });
});

describe("a Report's transcripts section", () => {
  test('parses with its sources and spool', () => {
    const parsed = ReportSchema.parse({ ...report(), transcripts });

    expect(parsed.transcripts).toEqual(transcripts);
  });

  test('is optional', () => {
    expect(ReportSchema.parse(report()).transcripts).toBeUndefined();
  });

  test('may list no sources, when capture is off', () => {
    const off = { sources: [], spool: { bytes: 0, oldestAt: null } };

    expect(ReportSchema.parse({ ...report(), transcripts: off }).transcripts).toEqual(off);
  });

  // A newer Collector may support a Harness this Hub predates (ADR-0004).
  test('accepts a Harness the Hub does not know', () => {
    const newer = {
      ...transcripts,
      sources: [{ harness: 'gemini', name: 'gemini', status: 'capturing' }],
    };

    expect(ReportSchema.safeParse({ ...report(), transcripts: newer }).success).toBe(true);
  });

  test.each([
    [
      'two sources with one name',
      {
        ...transcripts,
        sources: [
          { harness: 'claude-code', name: 'claude', status: 'capturing' },
          { harness: 'codex', name: 'claude', status: 'capturing' },
        ],
      },
    ],
    [
      'an unknown status',
      { ...transcripts, sources: [{ harness: 'codex', name: 'codex', status: 'paused' }] },
    ],
    ['a negative spool size', { ...transcripts, spool: { bytes: -1, oldestAt: null } }],
  ])('rejects %s', (_, section) => {
    expect(ReportSchema.safeParse({ ...report(), transcripts: section }).success).toBe(false);
  });
});
