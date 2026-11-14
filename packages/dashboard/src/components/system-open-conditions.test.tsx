import { expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import { linksIn, renderRouted } from './render-routed.tsx';
import {
  SystemMaintenance,
  SystemMaintenanceLine,
  SystemOpenConditions,
} from './system-open-conditions.tsx';

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

const update = (level: 'alert' | 'note' | 'warning'): Attention => ({
  checkedAt: 0,
  conditionId: `update-${level}`,
  evidence: 'current',
  firstDetected: 0,
  kind: 'pending_update',
  level,
  reason: '3 packages are pending.',
  subject: JSON.stringify(['apt', 'system']),
  system: 'server-1',
  unpaired: false,
});

const reboot: Attention = {
  checkedAt: 0,
  conditionId: 'reboot',
  evidence: 'current',
  firstDetected: 0,
  kind: 'reboot_required',
  level: 'note',
  reason: 'A reboot is required.',
  subject: '',
  system: 'server-1',
  unpaired: false,
};

test('maintenance notes leave Open Conditions for a Maintenance section that links each to its page', async () => {
  const items = [update('note'), reboot, down];
  const html = await renderRouted(
    <>
      <SystemOpenConditions items={items} now={6 * 86_400_000} />
      <SystemMaintenance items={items} now={6 * 86_400_000} />
    </>,
  );
  const [open = '', maintenance = ''] = html.split('>Maintenance<');

  expect(open).toContain('/conditions/down');
  expect(open).not.toContain('/conditions/update-note');
  expect(open).not.toContain('/conditions/reboot');
  expect(maintenance).toContain('href="/systems/server-1/conditions/update-note"');
  expect(maintenance).toContain('Pending update APT (system)');
  expect(maintenance).toContain('href="/systems/server-1/conditions/reboot"');
  expect(maintenance).toContain('Reboot required');
  expect(maintenance).toContain('open 6 d');
  expect(maintenance).not.toContain('/conditions/down');
});

test('a Pending update at warning stays in Open Conditions, and no Maintenance section shows without a maintenance note', async () => {
  const items = [update('warning'), restarted];
  const html = await renderRouted(<SystemOpenConditions items={items} now={1000} />);

  expect(html).toContain('/conditions/update-warning');
  expect(await renderRouted(<SystemMaintenance items={items} now={1000} />)).toBe('');
});

test("the wide Maintenance line links each note to its Condition page, and Service updates to the System's Services", async () => {
  const html = await renderRouted(
    <SystemMaintenanceLine items={[update('note'), reboot, down]} now={1000} system="server-1" />,
  );
  const links = linksIn(html);

  expect(links.map(({ href }) => href)).toEqual([
    '/systems/server-1/conditions/update-note',
    '/systems/server-1/conditions/reboot',
    expect.stringMatching(/^\/services\?.*updates.*server-1/u),
  ]);
  expect(links.at(-1)?.label).toBe('Service updates →');
});
