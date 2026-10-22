import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SilenceBanner, silenceLeft } from './silence-line.tsx';

const NOW = Date.UTC(2026, 9, 13, 22, 30, 0);
const UNTIL = NOW + 2 * 3_600_000;
const MINUTE = 60_000;

test('the time left rounds up to the minute, as heimdall-hub silence lists it', () => {
  expect(silenceLeft(NOW, NOW + 2 * 3_600_000 - 30_000)).toBe('2 h');
  expect(silenceLeft(NOW, NOW + 20_000)).toBe('1 min');
  expect(silenceLeft(NOW, NOW + 90 * MINUTE + 1)).toBe('1 h 31 min');
});

// The server cannot know the viewer's zone, so "until <time>" is written by the
// browser, and the rest reads whole without it.
test('the System page banner also says Conditions still show and count toward health', () => {
  const markup = renderToStaticMarkup(<SilenceBanner now={NOW} until={UNTIL} />);

  expect(markup).toContain(
    'Alerts silenced · 2 h left. Conditions still show and count toward health.',
  );
});

test('nothing renders without a silence', () => {
  expect(renderToStaticMarkup(<SilenceBanner now={NOW} until={undefined} />)).toBe('');
});
