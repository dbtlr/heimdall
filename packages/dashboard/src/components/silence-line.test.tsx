import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SilenceBanner, SilenceLine } from './silence-line.tsx';

const NOW = Date.UTC(2026, 9, 13, 22, 30, 0);
const UNTIL = NOW + 2 * 3_600_000;
const MINUTE = 60_000;

// The server cannot know the viewer's zone, so "until <time>" is written by the
// browser, and the rest reads whole without it.
test('the Fleet card line says alerts are silenced, with the time left', () => {
  const markup = renderToStaticMarkup(<SilenceLine now={NOW} until={UNTIL} />);

  expect(markup).toBe(
    '<p class="mt-1 text-sm text-muted-foreground">Alerts silenced · 2 h left</p>',
  );
});

test('the time left rounds up to the minute, as heimdall-hub silence lists it', () => {
  const left = (until: number) => renderToStaticMarkup(<SilenceLine now={NOW} until={until} />);

  expect(left(NOW + 2 * 3_600_000 - 30_000)).toContain('· 2 h left');
  expect(left(NOW + 20_000)).toContain('· 1 min left');
  expect(left(NOW + 90 * MINUTE + 1)).toContain('· 1 h 31 min left');
});

test('the System page banner also says Conditions still show and count toward health', () => {
  const markup = renderToStaticMarkup(<SilenceBanner now={NOW} until={UNTIL} />);

  expect(markup).toContain(
    'Alerts silenced · 2 h left. Conditions still show and count toward health.',
  );
});

test('nothing renders without a silence', () => {
  expect(renderToStaticMarkup(<SilenceLine now={NOW} until={undefined} />)).toBe('');
  expect(renderToStaticMarkup(<SilenceBanner now={NOW} until={undefined} />)).toBe('');
});
