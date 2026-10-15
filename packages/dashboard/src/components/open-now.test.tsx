import { expect, test } from 'bun:test';

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Attention } from '../server/attention-types.ts';
import { AttentionStatus } from './attention-status.tsx';
import { OpenNow } from './open-now.tsx';

test('the status counts an old Condition once and keeps notes out of the action count', () => {
  const alert: Attention = {
    checkedAt: 100,
    disk: undefined,
    evidence: 'current',
    firstDetected: 0,
    kind: 'low_disk',
    level: 'alert',
    reason: '92% used',
    subject: '/',
    system: 'gateway-1',
    unpaired: false,
  };
  const oldWarning: Attention = { ...alert, evidence: 'old', level: 'warning', subject: '/data' };
  const note: Attention = { ...alert, level: 'note', subject: '/backup' };
  const html = renderToStaticMarkup(
    <AttentionStatus items={[alert, oldWarning, note]} status="needs_you" />,
  );
  expect(html.match(/>\+1\?</gu)).toHaveLength(1);
  expect(html).not.toContain('>+1</span>');

  const oldLead = renderToStaticMarkup(
    <AttentionStatus
      items={[{ ...alert, evidence: 'old' }, { ...oldWarning, evidence: 'current' }, note]}
      status="needs_you"
    />,
  );
  expect(oldLead).toContain('>+1</span>');
  expect(oldLead).not.toContain('+1?');
});

test('a note-only System stays Up while its note remains visible in Open now', async () => {
  const note: Attention = {
    checkedAt: 100,
    disk: undefined,
    evidence: 'current',
    firstDetected: 0,
    kind: 'low_disk',
    level: 'note',
    reason: '72% used',
    subject: '/',
    system: 'gateway-1',
    unpaired: false,
  };
  const routeTree = createRootRoute({
    component: () => (
      <>
        <AttentionStatus items={[note]} status="up" />
        <OpenNow items={[note]} now={100} />
      </>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree,
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('Up');
  expect(html).toContain('Open now · 1 open');
  expect(html).toContain('Low disk');
  expect(html).toContain('Hub level: note');
  expect(html).not.toContain('Needs you');
});
