import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SampleInspector } from './sample-inspector.tsx';

test('a pending sample read reports loading instead of claiming there is no sample', () => {
  const html = renderToStaticMarkup(<SampleInspector failed={false} loading sample={null} />);
  expect(html).toContain('Reading sample');
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('No Vitals sample to inspect');
});
