import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { clockAt } from '../lib/phrase.ts';
import { DateTime, InZone, PhraseText } from './date-time.tsx';

const AT = Date.UTC(2026, 9, 13, 22, 30, 0);

// The server cannot know the viewer's zone, so it writes no time at all.
test('on the server a DateTime is an empty time element', () => {
  expect(renderToStaticMarkup(<DateTime at={AT} format="clock" />)).toBe(
    '<time dateTime="2026-10-13T22:30:00.000Z"></time>',
  );
});

test('on the server an InZone renders nothing, glue text included', () => {
  expect(renderToStaticMarkup(<InZone>{(zone) => `Sample at ${zone}`}</InZone>)).toBe('');
});

test('on the server a phrase with a time renders nothing, and one without renders whole', () => {
  expect(renderToStaticMarkup(<PhraseText phrase={['Sample at ', clockAt(AT)]} />)).toBe('');
  expect(renderToStaticMarkup(<PhraseText phrase={['CPU 3%, ', 'memory 47%']} />)).toBe(
    'CPU 3%, memory 47%',
  );
});
