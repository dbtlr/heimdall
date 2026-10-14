import { expect, test } from 'bun:test';

import { clockAt, clockSpan, phraseText, phraseTitle, whenAt, zoneFreeText } from './phrase.ts';

// 2026-10-13 22:30 UTC: Tuesday 18:30 in New York, Wednesday 00:30 in Berlin.
const T = Date.UTC(2026, 9, 13, 22, 30, 0);
const HOUR = 3_600_000;

test.each([
  ['Europe/Berlin', 'since Wed 00:30, 14:00 to 15:00'],
  ['America/New_York', 'since 18:30, 08:00 to 09:00'],
] as const)('a phrase spells its times in %s', (zone, text) => {
  const phrase = [
    'since ',
    whenAt(T, T - HOUR),
    ', ',
    ...clockSpan(T - 10.5 * HOUR, T - 9.5 * HOUR),
  ];
  expect(phraseText(phrase, zone)).toBe(text);
});

test('a phrase with no time reads the same without a zone', () => {
  expect(zoneFreeText(['CPU 3%', ', ', 'memory 47%'])).toBe('CPU 3%, memory 47%');
});

test('a phrase with a time has no text until a zone is known', () => {
  expect(zoneFreeText(['silent since ', clockAt(T)])).toBeUndefined();
});

test('a clock span ending nowhere ends at "now"', () => {
  expect(phraseText(clockSpan(T, undefined), 'Europe/Berlin')).toBe('00:30 to now');
});

test('a title has no text until a zone is known', () => {
  expect(phraseTitle(['at ', clockAt(T)], undefined)).toBeUndefined();
  expect(phraseTitle(['at ', clockAt(T)], 'America/New_York')).toBe('at 18:30');
});
