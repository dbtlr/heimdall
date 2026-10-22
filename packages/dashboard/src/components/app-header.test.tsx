import { expect, test } from 'bun:test';

import { AppHeader } from './app-header.tsx';
import { renderRouted } from './render-routed.tsx';

test('inline sits on the first row, apart from the children that wrap to their own row on a phone', async () => {
  const html = await renderRouted(<AppHeader inline={<b>verdict</b>}>{<i>range</i>}</AppHeader>);

  const verdict = html.indexOf('<b>verdict</b>');
  const wrapped = html.indexOf('basis-full');
  expect(verdict).toBeGreaterThan(-1);
  expect(wrapped).toBeGreaterThan(verdict);
  expect(html.indexOf('<i>range</i>')).toBeGreaterThan(wrapped);
});

test('without inline the header holds no extra element, and children keep their full-row wrapper', async () => {
  const html = await renderRouted(<AppHeader>{<i>range</i>}</AppHeader>);

  expect(html).not.toContain('verdict');
  expect(html).toContain('basis-full');
});
