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

test('the table layout makes each compact row one grid line from lg, with an sr-only level word', async () => {
  const html = await renderRouted(
    <AttentionList compact items={[disk]} layout="table" now={1000} />,
  );
  expect(html).toContain('lg:grid');
  expect(html).toContain('lg:grid-cols-[16px_11rem_15rem_minmax(0,1fr)_5.5rem_7rem_auto]');
  expect(html).toContain('<span class="lg:sr-only">Warning</span>');
  expect(html).toContain('open 1 s');
  expect(html).toContain('Free space or grow the disk');
  expect(html).toContain('href="/systems/gateway-1/conditions/c-disk"');
});

test('without the table layout a compact row carries no lg grid classes', async () => {
  const html = await renderRouted(<AttentionList compact items={[disk]} now={1000} />);
  expect(html).not.toMatch(/lg:grid(?!-cols)/u);
  expect(html).not.toContain('lg:contents');
  expect(html).not.toContain('lg:sr-only');
});
