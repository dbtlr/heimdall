import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { HubStatus } from '../server/hub-status-types.ts';
import { HubStatusContent, hubVerdict } from './hub-status.tsx';

const STATUS: HubStatus = {
  checks: [
    {
      detail: ['Parser rebuild stalled'],
      part: 'Session insight',
      state: 'warning',
      text: ['1 generation failed'],
    },
    { detail: [], part: 'Database', state: 'ok', text: ['1.2 GiB · schema 46'] },
  ],
  details: [{ columns: ['Migration'], notes: [], rows: [[['46']]], title: 'Migrations applied' }],
  down: undefined,
  runtime: 'recorded',
  tables: [
    {
      columns: ['System', 'Collector'],
      notes: [['Pairing code issued for tablet-1, expires in 6 min.']],
      rows: [[['server-1'], ['1.2.3']]],
      title: 'Systems and Collectors',
    },
  ],
  version: '1.2.3',
};

test('the checklist comes first, the tables fold on a phone, and the rest folds behind Details', () => {
  const html = renderToStaticMarkup(<HubStatusContent status={STATUS} />);
  expect(html).toContain('1 needs a look');
  expect(html).toContain('Session insight needs attention.');
  expect(html).toContain('aria-label="warning"');
  expect(html).toContain('Parser rebuild stalled');
  expect(html.indexOf('Hub health checklist')).toBeLessThan(html.indexOf('<table'));
  expect(html).toMatch(/<details class="mt-5 sm:hidden"><summary[^>]*>Systems and Collectors</u);
  expect(html).toMatch(/<summary[^>]*>Details: migrations applied<\/summary>/u);
  expect(html).toContain('Pairing code issued for tablet-1');
});

test('the verdict agrees in number and names a silent Hub once', () => {
  const two = {
    ...STATUS,
    checks: STATUS.checks.map((c) => ({ ...c, state: 'warning' as const })),
  };
  expect(hubVerdict(two)).toEqual({
    summary: ['Session insight and Database need attention. Everything else is current.'],
    verdict: '2 need a look',
  });
  expect(hubVerdict({ ...two, down: ['The Hub has recorded nothing for 3 min.'] })).toEqual({
    summary: ['The Hub has recorded nothing for 3 min.'],
    verdict: 'Hub silent',
  });
  expect(hubVerdict({ ...STATUS, checks: [] }).verdict).toBe('All well');
});
