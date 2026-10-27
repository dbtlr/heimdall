import { expect, test } from 'bun:test';

import type { ServiceDetail } from '../server/service-detail-types.ts';
import { renderRouted } from './render-routed.tsx';
import { ServicePanel } from './service-panel.tsx';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const HOUR = 3_600_000;

const detail = (over: Partial<ServiceDetail> = {}): ServiceDetail => ({
  downs: [],
  installed: { missingApplication: undefined, upstream: null, version: null },
  installs: [],
  note: undefined,
  now: NOW,
  recorded: undefined,
  service: 'web',
  stops: [],
  system: 'server-1',
  unit: undefined,
  update: { failure: undefined, status: undefined },
  updates: [],
  ...over,
});

// The panel's words, with tags dropped and times shown as [time].
const text = (html: string) =>
  html.replace(/<time\b[^>]*>.*?<\/time>/gu, '[time]').replace(/<[^>]+>/gu, ' ');

test('lists each check, then the record, the installed version, and the update', async () => {
  const html = await renderRouted(
    <ServicePanel
      detail={detail({
        installed: { missingApplication: undefined, upstream: 'github:web/web', version: '1.2' },
        recorded: {
          checks: [
            { check: 'supervisor', detail: 'running', since: NOW - HOUR, state: 'up' },
            { check: 'health', detail: 'HTTP 503', since: NOW - HOUR, state: 'unhealthy' },
          ],
          name: 'web',
          supervisor: 'systemd-user',
        },
        unit: 'web.service',
        update: {
          failure: undefined,
          status: { kind: 'update', since: NOW - 2 * HOUR, source: 'upstream', version: '1.3' },
        },
      })}
    />,
  );
  // A check's text names a time, so it renders only in the browser's zone;
  // serviceChecks' tests cover its words.
  const words = text(html).replace(/\s+/gu, ' ');
  expect(words).toContain('Checks Supervisor Health Record');
  expect(html.indexOf('bg-status-good')).toBeLessThan(html.indexOf('bg-status-critical'));
  expect(words).toContain(
    'Record Supervisor systemd user Unit web.service Installed 1.2 Upstream github:web/web',
  );
  expect(words).toContain('Update 1.3 · available since [time]');
});

test('says when the Collector has not checked the Service yet', async () => {
  const html = await renderRouted(
    <ServicePanel
      detail={detail({ recorded: { checks: [], name: 'web', supervisor: 'docker' } })}
    />,
  );
  expect(text(html)).toContain('Not checked yet');
  expect(text(html)).toContain('Docker');
});

test('a Service its provisioner forgot shows no checks, only what the Hub still knows', async () => {
  const html = await renderRouted(
    <ServicePanel
      detail={detail({
        installed: { missingApplication: 'web', upstream: null, version: null },
      })}
    />,
  );
  expect(html).not.toContain('Checks');
  expect(html).not.toContain('Supervisor');
  expect(text(html).replace(/\s+/gu, ' ')).toContain(
    'Installed Unknown Application web, not recorded',
  );
});
