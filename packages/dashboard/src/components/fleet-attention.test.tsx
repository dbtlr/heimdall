import { expect, test } from 'bun:test';

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Attention } from '../server/attention-types.ts';
import { FleetAttention } from './fleet-attention.tsx';

test('Fleet shows an old alert ahead of a fresh warning and collapses notes without hiding evidence gaps', async () => {
  const disk: Attention = {
    checkedAt: 0,
    disk: undefined,
    evidence: 'old',
    firstDetected: 0,
    kind: 'low_disk',
    level: 'alert',
    reason: '92% used',
    subject: '/urgent',
    system: 'server-1',
    unpaired: false,
  };
  const items: Attention[] = [
    { ...disk, evidence: 'current', level: 'warning', subject: '/warning' },
    { ...disk, level: 'note', subject: '/note' },
    disk,
    {
      checkedAt: 0,
      evidence: 'old',
      firstDetected: 0,
      kind: 'checks_missing',
      set: 'checks',
      subject: '',
      system: 'server-1',
      unpaired: false,
    },
  ];
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: createRootRoute({
      component: () => <FleetAttention items={items} now={10_000_000} />,
    }),
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html.indexOf('/urgent')).toBeLessThan(html.indexOf('/warning'));
  expect(html).toContain('Evidence old');
  expect(html).toContain('Free space or grow the disk');
  expect(html).toContain('<summary');
  expect(html).toContain('1 note');
  expect(html).not.toContain('<details open');
  expect(html).toContain('Evidence old or unknown');
  expect(html).toContain('#low-disk-urgent');
});
