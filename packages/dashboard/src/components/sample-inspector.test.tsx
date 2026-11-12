import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { SampleInspection } from '../server/system-detail-types.ts';
import { SampleInspector } from './sample-inspector.tsx';

const NOW = 1_800_000_000_000;
const GIB = 1024 ** 3;

const inspected: SampleInspection = {
  bucket: undefined,
  cpuBusyPercent: 20,
  load1: 1,
  memoryHolders: undefined,
  memoryTotalBytes: 16 * GIB,
  memoryUsedBytes: 15 * GIB,
  processes: [],
  t: NOW,
  unlinked: [],
};

test('a pending sample read reports loading instead of claiming there is no sample', () => {
  const html = renderToStaticMarkup(<SampleInspector failed={false} loading sample={null} />);
  expect(html).toContain('Reading sample');
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('No Vitals sample to inspect');
});

test('states memory in GiB, the unit the memory chart beside it uses', () => {
  const html = renderToStaticMarkup(<SampleInspector failed={false} sample={inspected} />);
  expect(html).toContain('15.0 / 16.0 GiB');
  expect(html).not.toMatch(/\bGB\b/u);
});

test('names the processes holding the most memory when a sample carries them, and shows no heading when none does', () => {
  const memoryHolders = { processes: [{ name: 'postgres', pid: 7, rssBytes: 4 * GIB }], t: NOW };
  const html = renderToStaticMarkup(
    <SampleInspector failed={false} sample={{ ...inspected, memoryHolders }} />,
  );
  for (const text of ['Processes holding the most memory', 'postgres', 'pid 7', '4.0 GiB']) {
    expect(html).toContain(text);
  }
  expect(renderToStaticMarkup(<SampleInspector failed={false} sample={inspected} />)).not.toContain(
    'Processes holding the most memory',
  );
});
