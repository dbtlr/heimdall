import type { ReactNode } from 'react';

import { phraseText, zoneFreeText } from '../lib/phrase.ts';
import type { Phrase } from '../lib/phrase.ts';
import { formatTime } from '../lib/time.ts';
import type { TimeFormat } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';

// Renders what `children` makes from the viewer's zone, and nothing until the
// browser's zone is known. The server and the first client render cannot know
// it, so both render nothing, and nothing mismatches. Put a time and the words
// that only make sense beside it inside, so the two appear together.
export function InZone({ children }: { children: (timeZone: string) => ReactNode }) {
  const timeZone = useTimeZone();
  return timeZone === undefined ? null : children(timeZone);
}

// A time in the viewer's own zone, in an empty `<time>` until the zone is known.
export function DateTime({
  at,
  className,
  ...format
}: TimeFormat & { at: number; className?: string }) {
  return (
    <time className={className} dateTime={new Date(at).toISOString()}>
      <InZone>{(timeZone) => formatTime(at, timeZone, format)}</InZone>
    </time>
  );
}

// A phrase: whole at once if it holds no time, else only once the zone is known.
export function PhraseText({ phrase }: { phrase: Phrase }) {
  return zoneFreeText(phrase) ?? <InZone>{(timeZone) => phraseText(phrase, timeZone)}</InZone>;
}
