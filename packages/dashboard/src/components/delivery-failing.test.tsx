import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { MARK_COLOR } from './attention-status.tsx';
import { DeliveryFailing } from './delivery-failing.tsx';

const SINCE = Date.UTC(2026, 9, 13, 22, 30, 0);

// The server cannot know the viewer's zone, so the time itself is written by the browser.
test('the line says alert delivery is failing, since a time, in the warning colour', () => {
  const markup = renderToStaticMarkup(<DeliveryFailing now={SINCE + 3_600_000} since={SINCE} />);

  expect(markup).toContain('Alert delivery failing since ');
  expect(markup).toContain('<time dateTime="2026-10-13T22:30:00.000Z">');
  expect(markup).toContain(MARK_COLOR.warning);
});
