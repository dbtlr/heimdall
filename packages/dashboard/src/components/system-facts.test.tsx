import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';
import { renderToStaticMarkup } from 'react-dom/server';

import { readSystemPage } from '../server/system-detail.ts';
import { SystemFacts } from './system-facts.tsx';

beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

test('a clock rollback keeps an open alert in the page and its disk bar', async () => {
  await using h = await startHub();
  const body = report('server-1', [NOW]);
  body.samples = body.samples.map((sample) => ({
    ...sample,
    disks: [{ mount: '/', totalBytes: 100, usedBytes: 99 }],
  }));
  await push(h.hub, body, { token: 'server-token' });
  await timeline(NOW).addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'alert',
    raisedAt: 60,
    subject: '/',
    system: 'server-1',
  });

  const page = await readSystemPage(h.db.sql, { name: 'server-1', now: NOW, range: '12h' });
  if (page === undefined) {
    throw new Error('The reported System must have a page.');
  }
  expect(page.detail.status).toBe('needs_you');
  expect(page.detail.conditions).toMatchObject([{ level: 'alert', raisedAt: NOW + 60_000 }]);
  expect(page.records.timeline[0]?.level).toBe('alert');
  expect(page.attention[0]?.level).toBe('alert');
  expect(renderToStaticMarkup(<SystemFacts detail={page.detail} />)).toContain(
    'bg-status-critical',
  );
});

test('disk bars use the stored Hub level instead of inferring urgency from disk use', () => {
  const html = renderToStaticMarkup(
    <SystemFacts
      detail={{
        conditions: [
          {
            clearedAt: undefined,
            id: '1',
            kind: 'low_disk',
            level: 'note',
            raisedAt: 0,
            subject: '/',
            transitions: [],
          },
        ],
        harnesses: undefined,
        latest: {
          cpuBusyPercent: 1,
          disks: [{ mount: '/', totalBytes: 100, usedBytes: 99 }],
          load: [0, 0, 0],
          memoryTotalBytes: 100,
          memoryUsedBytes: 1,
          t: 0,
          uptimeSeconds: 100,
        },
        now: 0,
      }}
    />,
  );
  expect(html).toContain('bg-status-warning');
  expect(html).not.toContain('bg-status-serious');
});
