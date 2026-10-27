import { expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import { OpenNow } from './open-now.tsx';
import { renderRouted } from './render-routed.tsx';
import { SystemOpenConditions } from './system-open-conditions.tsx';

const restarted: Attention = {
  checkedAt: 0,
  conditionId: 'restart',
  evidence: 'current',
  firstDetected: 0,
  kind: 'service_restarted',
  level: 'note',
  reason: 'Stopped once',
  service: undefined,
  subject: 'web',
  system: 'server-1',
  unpaired: false,
};
const down: Attention = {
  checkedAt: 0,
  checks: [],
  conditionId: 'down',
  evidence: 'current',
  firstDetected: 0,
  kind: 'service_down',
  level: 'alert',
  reason: 'Service is down',
  service: undefined,
  subject: 'web',
  system: 'server-1',
  unpaired: false,
};

test('System Open Conditions omits restart notes while keeping Service down', async () => {
  const html = await renderRouted(<SystemOpenConditions items={[restarted, down]} now={1000} />);
  expect(html).toContain('Open Conditions');
  expect(html).toContain('Service down');
  expect(html).not.toContain('Service restarted');
  expect(html).not.toContain('/conditions/restart');
  expect(html).toContain('/conditions/down');
});

test('restart notes alone leave System Open Conditions empty', async () => {
  const html = await renderRouted(<SystemOpenConditions items={[restarted]} now={1000} />);
  expect(html).toContain('No open Condition or uncertain evidence.');
  expect(html).not.toContain('<details');
});

test('the Fleet unpaired section keeps Service restarted notes', async () => {
  const html = await renderRouted(
    <OpenNow items={[{ ...restarted, unpaired: true }]} now={1000} />,
  );
  expect(html).toContain('Service restarted');
  expect(html).toContain('/conditions/restart');
});
