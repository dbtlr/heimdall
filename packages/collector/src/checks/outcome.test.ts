import { describe, expect, test } from 'bun:test';

import { MAX_CHECK_DETAIL_LENGTH } from '@heimdall/schema';

import { clampDetail, supervisorOutcome } from './outcome.ts';

describe('a check detail', () => {
  test('is kept as it is when it is short and plain', () => {
    expect(clampDetail('ActiveState=active')).toBe('ActiveState=active');
  });

  test('has control characters, NUL and line breaks included, taken out', () => {
    expect(clampDetail('a\u0000b\nc\td\u007fe\u001b[0m')).toBe('abcde[0m');
  });

  test('is cut to what the Hub takes', () => {
    expect(clampDetail('x'.repeat(500))).toHaveLength(MAX_CHECK_DETAIL_LENGTH);
  });

  test('is never cut through a surrogate pair', () => {
    const cut = clampDetail(`${'x'.repeat(MAX_CHECK_DETAIL_LENGTH - 1)}\u{1f600}`);

    expect(cut).toBe('x'.repeat(MAX_CHECK_DETAIL_LENGTH - 1));
    expect(cut.isWellFormed()).toBe(true);
  });

  test('keeps a surrogate pair that fits whole', () => {
    const detail = `${'x'.repeat(MAX_CHECK_DETAIL_LENGTH - 2)}\u{1f600}`;

    expect(clampDetail(detail)).toBe(detail);
  });

  test('is well-formed even when the text held a lone surrogate', () => {
    expect(clampDetail('a\ud800b').isWellFormed()).toBe(true);
    expect(clampDetail(`${'x'.repeat(MAX_CHECK_DETAIL_LENGTH - 1)}\ud800`).isWellFormed()).toBe(
      true,
    );
  });

  test('is cleaned in an outcome of every state', () => {
    expect(supervisorOutcome('stopped', 'a\u0000b')).toEqual({
      check: 'supervisor',
      detail: 'ab',
      state: 'stopped',
    });
  });
});
