import { describe, expect, test } from 'bun:test';

import { cutChunks } from './chunks.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const texts = (cut: ReturnType<typeof cutChunks>) =>
  cut.chunks.map((chunk) => new TextDecoder().decode(chunk));

describe('cutting a growing file into chunks', () => {
  test('ends each chunk on a line boundary and keeps a partial last line for later', () => {
    const cut = cutChunks(bytes('{"a":1}\n{"b":2}\n{"c":'), { final: false, limit: 12 });

    expect(texts(cut)).toEqual(['{"a":1}\n', '{"b":2}\n']);
    expect(cut.consumed).toBe(16);
  });

  test('packs as many whole lines as fit within the limit', () => {
    const cut = cutChunks(bytes('a\nb\nc\nd\n'), { final: false, limit: 5 });

    expect(texts(cut)).toEqual(['a\nb\n', 'c\nd\n']);
  });

  test('splits a line longer than the limit at the limit', () => {
    const cut = cutChunks(bytes('abcdefghij\nk\n'), { final: false, limit: 4 });

    expect(texts(cut)).toEqual(['abcd', 'efgh', 'ij\n', 'k\n']);
    expect(cut.consumed).toBe(13);
  });

  test('takes a partial last line once the file is final', () => {
    const cut = cutChunks(bytes('a\nbc'), { final: true, limit: 10 });

    expect(texts(cut)).toEqual(['a\nbc']);
    expect(cut.consumed).toBe(4);
  });

  test('cuts final content without newlines at the limit', () => {
    const cut = cutChunks(bytes('abcdefghij'), { final: true, limit: 4 });

    expect(texts(cut)).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('consumes nothing from a single partial line', () => {
    const cut = cutChunks(bytes('{"a":'), { final: false, limit: 12 });

    expect(cut).toEqual({ chunks: [], consumed: 0 });
  });
});
