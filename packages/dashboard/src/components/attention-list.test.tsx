import { expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import { AttentionList } from './attention-list.tsx';
import { renderRouted } from './render-routed.tsx';

const disk: Attention = {
  checkedAt: 0,
  conditionId: 'c-disk',
  disk: undefined,
  evidence: 'current',
  firstDetected: 0,
  kind: 'low_disk',
  level: 'warning',
  reason: '82% used',
  subject: '/',
  system: 'gateway-1',
  unpaired: false,
};

const missing: Attention = {
  checkedAt: 0,
  evidence: 'old',
  firstDetected: 0,
  kind: 'checks_missing',
  set: 'checks',
  subject: '',
  system: 'gateway-1',
  unpaired: false,
};

const render = (items: Attention[]) => renderRouted(<AttentionList items={items} now={1000} />);

test('a Condition keeps its expandable details and adds a link to its page', async () => {
  const html = await render([disk]);
  expect(html).toContain('<details');
  expect(html).toContain('Free space or grow the disk');
  expect(html).toContain('href="/systems/gateway-1/conditions/c-disk"');
  expect(html).toContain('>Open<');
});

test('evidence the Hub holds no Condition for has no page to open', async () => {
  const html = await render([missing]);
  expect(html).toContain('<details');
  expect(html).not.toContain('/conditions/');
  expect(html).not.toContain('>Open<');
});
