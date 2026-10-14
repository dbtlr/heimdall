import { formatTime } from './time.ts';
import type { TimeFormat } from './time.ts';

// A time to spell in the viewer's zone: an instant and how to write it.
export type Moment = TimeFormat & { at: number };

// A sentence or part of one, as the words and times it is made of. The words
// are known on the server; the times wait for the browser's zone.
export type Phrase = readonly (Moment | string)[];

export const clockAt = (at: number): Moment => ({ at, format: 'clock' });

export const clockSecondsAt = (at: number): Moment => ({ at, format: 'clockSeconds' });

export const whenAt = (at: number, now: number): Moment => ({ at, format: 'when', now });

// "14:05 to 15:40", or "14:05 to now" when `end` is undefined.
export const clockSpan = (start: number, end: number | undefined): Phrase => [
  clockAt(start),
  ' to ',
  end === undefined ? 'now' : clockAt(end),
];

// The phrase written out, its times in `timeZone`.
export const phraseText = (phrase: Phrase, timeZone: string): string =>
  phrase
    .map((part) => (typeof part === 'string' ? part : formatTime(part.at, timeZone, part)))
    .join('');

// The phrase's text when it holds no time, so needs no zone; else undefined.
export const zoneFreeText = (phrase: Phrase): string | undefined =>
  phrase.every((part) => typeof part === 'string') ? phrase.join('') : undefined;

// The phrase as a tooltip, which cannot hold elements: undefined until the
// browser's zone is known.
export const phraseTitle = (phrase: Phrase, timeZone: string | undefined): string | undefined =>
  timeZone === undefined ? undefined : phraseText(phrase, timeZone);
