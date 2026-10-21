import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SilenceBanner, SilenceLine } from './silence-line.tsx';

const NOW = Date.UTC(2026, 9, 13, 22, 30, 0);
const UNTIL = NOW + 2 * 3_600_000;
const ISO = '<time dateTime="2026-10-14T00:30:00.000Z">';

// The server cannot know the viewer's zone, so the time itself is written by the browser.
test('the Fleet card line says alerts are silenced until a time, with the time left', () => {
  const markup = renderToStaticMarkup(<SilenceLine now={NOW} until={UNTIL} />);

  expect(markup).toContain('Alerts silenced until ');
  expect(markup).toContain(ISO);
  expect(markup).toContain('2 h left');
});

test('the System page banner also says Conditions still show and count toward health', () => {
  const markup = renderToStaticMarkup(<SilenceBanner now={NOW} until={UNTIL} />);

  expect(markup).toContain('Alerts silenced until ');
  expect(markup).toContain(ISO);
  expect(markup).toContain('2 h left');
  expect(markup).toContain('Conditions still show and count toward health.');
});

test('nothing renders without a silence', () => {
  expect(renderToStaticMarkup(<SilenceLine now={NOW} until={undefined} />)).toBe('');
  expect(renderToStaticMarkup(<SilenceBanner now={NOW} until={undefined} />)).toBe('');
});
