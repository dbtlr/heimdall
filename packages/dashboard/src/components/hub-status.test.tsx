import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { HubStatusContent } from './hub-status.tsx';

test('renders an accessible checklist and tables for both layouts without hiding the explanation', () => {
  const html = renderToStaticMarkup(
    <HubStatusContent
      status={{
        checks: [
          {
            detail: 'Parser rebuild stalled',
            part: 'Session insight',
            state: 'warning',
            text: '1 generation failed',
          },
        ],
        started: 'unknown',
        tables: [
          {
            columns: ['System', 'Collector'],
            rows: [['server-1', '1.2.3']],
            title: 'Systems and Collectors',
          },
        ],
        version: 'unknown',
      }}
    />,
  );
  expect(html).toContain('1 need a look');
  expect(html).toContain('aria-label="warning"');
  expect(html).toContain('Parser rebuild stalled');
  expect(html).toContain('<th');
  expect(html).toContain('1.2.3');
});
