import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { MARK_COLOR } from './attention-status.tsx';
import { FleetVerdict } from './fleet-verdict.tsx';

test('with no alert or warning the verdict says All clear with the healthy glyph', () => {
  const html = renderToStaticMarkup(<FleetVerdict counts={{ alert: 0, note: 4, warning: 0 }} />);

  expect(html).toContain('All clear');
  expect(html).toContain('stroke-status-good');
  expect(html).not.toContain('aria-label="4 notes"');
});

test('otherwise it shows each nonzero level with its glyph and count in the level color', () => {
  const html = renderToStaticMarkup(<FleetVerdict counts={{ alert: 1, note: 5, warning: 1 }} />);

  expect(html).toContain('aria-label="1 alert, 1 warning, 5 notes"');
  expect(html).not.toContain('All clear');
  expect(html).toContain('fill-status-critical');
  expect(html).toContain('fill-status-serious');
  expect(html).toContain('fill-status-warning');
  expect(html).toContain(`${MARK_COLOR.alert}">1<`);
  expect(html).toContain(`${MARK_COLOR.note}">5<`);
});

test('a level with no items is left out', () => {
  const html = renderToStaticMarkup(<FleetVerdict counts={{ alert: 0, note: 0, warning: 2 }} />);

  expect(html).toContain('aria-label="2 warnings"');
  expect(html).not.toContain('fill-status-critical');
  expect(html).not.toContain('fill-status-warning');
});
