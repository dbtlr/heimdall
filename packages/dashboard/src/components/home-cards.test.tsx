import { describe, expect, test } from 'bun:test';

import type { HomeJob } from '../server/home-types.ts';
import { ChangesCard, JobsCard, MaintenanceCardView } from './home-cards.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

describe('the Maintenance card', () => {
  test('shows each row with its Systems linking to their Conditions, and plans on the Maintenance page', async () => {
    const html = await renderRouted(
      <MaintenanceCardView
        card={{
          packages: {
            security: 14,
            systems: [
              { conditionId: '31', packages: 30, security: 10, system: 'server-1' },
              { conditionId: '32', packages: 8, security: 4, system: 'db-1' },
            ],
            text: '38 packages on 2 Systems',
          },
          reboots: {
            oldest: 'oldest 6 d',
            systems: [{ conditionId: '41', system: 'db-1' }],
            text: '1 System needs a reboot',
          },
          updates: { longest: 'ntfy 5 d', text: '4 Services have an update' },
        }}
      />,
    );
    const links = linksIn(html);

    expect(html).toContain('Maintenance · can wait');
    expect(html).toContain('38 packages on 2 Systems');
    expect(html).toContain('14 security');
    expect(links.find(({ label }) => label === 'server-130')?.href).toBe(
      '/systems/server-1/conditions/31',
    );
    expect(html).toContain('oldest 6 d');
    expect(links.find(({ label }) => label === 'db-1')?.href).toBe('/systems/db-1/conditions/41');
    expect(links.find(({ label }) => label.startsWith('4 Services'))?.href).toBe('/maintenance');
    expect(links.find(({ label }) => label === 'Plan →')?.href).toBe('/maintenance');
  });

  test('omits an empty row, shows no chip without security updates, and says when nothing is left', async () => {
    const one = await renderRouted(
      <MaintenanceCardView
        card={{
          packages: {
            security: 0,
            systems: [{ conditionId: '31', packages: 2, security: 0, system: 'server-1' }],
            text: '2 packages on 1 System',
          },
          reboots: undefined,
          updates: undefined,
        }}
      />,
    );

    expect(one).toContain('2 packages on 1 System');
    expect(one).not.toContain('security');
    expect(one).not.toContain('reboot');
    expect(one).not.toContain('Nothing to maintain.');

    const none = await renderRouted(
      <MaintenanceCardView
        card={{ packages: undefined, reboots: undefined, updates: undefined }}
      />,
    );

    expect(none).toContain('Nothing to maintain.');
  });
});

describe('the What changed card', () => {
  test('each group shows its words and leads to its page; with none it says so', async () => {
    const html = await renderRouted(
      <ChangesCard
        changes={[
          {
            at: NOW - MINUTE,
            change: {
              at: NOW - MINUTE,
              from: '0.10.0',
              kind: 'version',
              service: 'heimdall-collector',
              system: 'server-2',
              to: '0.10.1',
            },
            stops: { 'server-1': 1, 'server-2': 1 },
            systems: ['server-1', 'server-2'],
          },
          {
            at: NOW - 9 * MINUTE,
            change: {
              action: 'cleared',
              at: NOW - 9 * MINUTE,
              condition: 'drift',
              conditionId: '51',
              kind: 'condition',
              subject: '/etc/hosts',
              system: 'server-1',
            },
            stops: { 'server-1': 0 },
            systems: ['server-1'],
          },
        ]}
        now={NOW}
      />,
    );
    const links = linksIn(html);

    expect(links.map(({ href }) => href)).toEqual([
      '/activity',
      '/services?system=%5B%22server-1%22%2C%22server-2%22%5D',
      '/systems/server-1/conditions/51',
    ]);
    expect(html).toContain('heimdall-collector 0.10.0 → 0.10.1');
    expect(html).toContain('server-1 and server-2, restarted once each');
    expect(html).toContain('Drift cleared on server-1');
    expect(html).toContain('font-mono">/etc/hosts');

    expect(await renderRouted(<ChangesCard changes={[]} now={NOW} />)).toContain(
      'Nothing changed in the last 24 hours.',
    );
  });
});

const job = (name: string, state: HomeJob['state']): HomeJob => ({
  at: NOW - MINUTE,
  lastRunAt: NOW - MINUTE,
  name,
  state,
  system: 'db-1',
});

describe('the Jobs card', () => {
  test("lists at most 6 jobs in the order given, each linking to its System's Records, then how many more", async () => {
    const jobs = [
      job('backup', 'failing'),
      job('rotate', 'overdue'),
      ...['a', 'b', 'c', 'd', 'e'].map((name) => job(name, 'ok')),
    ];
    const html = await renderRouted(<JobsCard jobs={jobs} now={NOW} />);

    expect([...html.matchAll(/data-state="(\w+)"/gu)].map(([, state]) => state)).toEqual([
      'failing',
      'overdue',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(linksIn(html).find(({ label }) => label.startsWith('backup'))?.href).toBe(
      '/systems/db-1?tab=records',
    );
    expect(html).toContain('+1 more');
    expect(linksIn(html).find(({ label }) => label === 'All jobs →')?.href).toBe('/jobs');
  });

  test('says when no job is recorded', async () => {
    expect(await renderRouted(<JobsCard jobs={[]} now={NOW} />)).toContain('No job is recorded.');
  });
});
