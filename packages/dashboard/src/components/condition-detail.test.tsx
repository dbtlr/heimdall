import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ConditionDetailView } from '../lib/condition-detail.ts';
import { ConditionDetailPanel } from './condition-detail.tsx';

const NOW = 1_800_000_000_000;

const diskView: ConditionDetailView = {
  chart: {
    captions: {
      left: 'Disk used, last 7 days',
      right: '88 to 91%, lines at 70, 80, 90',
      rule: undefined,
    },
    domain: [65, 100],
    label: 'Disk used over the last 7 days',
    lines: [
      { label: '70%', level: 'note', value: 70 },
      { label: '80%', level: 'warning', value: 80 },
      { label: '90%', level: 'alert', value: 90 },
    ],
    points: [
      { t: NOW - 7 * 86_400_000, value: 88 },
      { t: NOW - 3_600_000, value: 90 },
      { t: NOW, value: 91 },
    ],
    window: { from: NOW - 7 * 86_400_000, to: NOW },
  },
  cleared: false,
  evidenceNote: undefined,
  hero: { text: ['used. 38 GiB free of 431 GiB on /.'], unit: '%', value: '91' },
  history: [
    {
      at: NOW - 3 * 86_400_000,
      backfilled: true,
      label: 'Note at 70%',
      level: 'note',
      reason: undefined,
    },
    {
      at: NOW - 86_400_000,
      backfilled: false,
      label: 'Warning at 80%',
      level: 'warning',
      reason: undefined,
    },
  ],
  level: 'warning',
  nextStep: {
    clears: 'The warning clears below 78%.',
    steps: [
      {
        commands: ['df -h /'],
        text: 'On gateway-1, find what fills / and remove it, or grow the disk.',
        title: 'Free space or grow the disk',
      },
    ],
  },
  provenance: 'Used space is the highest reading in each 5 minutes. Updated 2 min ago.',
  rate: {
    estimate: true,
    text: '+2.1 GiB a day over the last 7 days. At that rate it is full in about 18 days.',
  },
  system: 'gateway-1',
  title: 'Low disk /',
};

const html = (view: ConditionDetailView) =>
  renderToStaticMarkup(<ConditionDetailPanel now={NOW} view={view} />);

test('leads with the title, the level, and the number with its unit and sentence', () => {
  const page = html(diskView);
  expect(page).toContain('<h1');
  expect(page).toContain('Low disk /');
  expect(page).toContain('Warning');
  expect(page).toContain('>91<');
  expect(page).toContain('>%<');
  expect(page).toContain('used. 38 GiB free of 431 GiB on /.');
});

test('marks the growth rate as an estimate', () => {
  const page = html(diskView);
  expect(page).toContain('At that rate it is full in about 18 days.');
  expect(page).toContain('Estimate');
  expect(html({ ...diskView, rate: undefined })).not.toContain('Estimate');
});

test('draws the chart with its captions', () => {
  const page = html(diskView);
  expect(page).toContain('aria-label="Disk used over the last 7 days"');
  expect(page).toContain('Disk used, last 7 days');
  expect(page).toContain('88 to 91%, lines at 70, 80, 90');
});

test('shows the rule beside a load chart', () => {
  const chart = diskView.chart;
  if (chart === undefined) {
    throw new Error('fixture has a chart');
  }
  const page = html({
    ...diskView,
    chart: { ...chart, captions: { ...chart.captions, rule: '90% for 30 of 60 min is a note' } },
  });
  expect(page).toContain('90% for 30 of 60 min is a note');
});

test('lists how it got here in order, with backfilled levels marked', () => {
  const page = html(diskView);
  expect(page).toContain('How it got here');
  expect(page.indexOf('Note at 70%')).toBeLessThan(page.indexOf('Warning at 80%'));
  expect(page.match(/Backfilled level/gu)).toHaveLength(1);
});

test('gives the next step with its commands, when it clears, and where the reading comes from', () => {
  const page = html(diskView);
  expect(page).toContain('Next step.');
  expect(page).toContain('find what fills / and remove it');
  expect(page).toContain('df -h /');
  expect(page).toContain('The warning clears below 78%.');
  expect(page).toContain('Updated 2 min ago.');
});

test('a cleared Condition keeps its level, says it cleared, and has no next step', () => {
  const page = html({ ...diskView, cleared: true, nextStep: undefined, rate: undefined });
  expect(page).toContain('Warning');
  expect(page).toContain('Cleared');
  expect(page).not.toContain('Next step.');
});

test('a Condition with no chart draws none and keeps the rest', () => {
  const page = html({ ...diskView, chart: undefined, rate: undefined });
  expect(page).not.toContain('data-slot="chart"');
  expect(page).toContain('How it got here');
});

test('a long title and sentence wrap instead of widening a 390 px screen', () => {
  const page = html({ ...diskView, title: `Low disk /${'a'.repeat(200)}` });
  expect(page).toContain('wrap-anywhere');
  expect(page).toContain('min-w-0');
  expect(page).not.toContain('whitespace-nowrap');
});
