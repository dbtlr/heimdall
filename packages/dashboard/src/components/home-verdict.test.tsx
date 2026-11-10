import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { HomeVerdictCard } from './home-verdict.tsx';

const figures = { awake: 6, services: 22, servicesUp: 21, systems: 7 };

test('the card takes the worst level on its edge and shows the figures beside the sentence', () => {
  const html = renderToStaticMarkup(
    <HomeVerdictCard
      figures={figures}
      verdict={{
        level: 'alert',
        sentence: 'proxy is down on edge-1.',
        support: ['Down for 4 min.'],
      }}
    />,
  );

  expect(html).toContain('border-l-status-critical');
  expect(html).toContain('>proxy is down on edge-1.</h2>');
  expect(html).toContain('Down for 4 min.');
  expect(html).toContain('>Systems awake</dt><dd');
  expect(html).toContain('>6<span');
  expect(html).toContain('> / 7</span>');
  expect(html).toContain('>21<span');
});

test("with agent work read, the Sessions running and today's cost in whole dollars follow Services up", () => {
  const html = renderToStaticMarkup(
    <HomeVerdictCard
      agents={{ running: 3, today: { pricedCostUsd: 148.3, requests: 9, unpricedRequests: 1 } }}
      figures={figures}
      verdict={{ level: 'healthy', sentence: 'Everything is healthy.', support: [] }}
    />,
  );
  const labels = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/gu)].map(([, label]) => label);

  expect(labels).toEqual(['Systems awake', 'Services up', 'Sessions running', 'agents today']);
  expect(html).toContain('>3</dd>');
  expect(html.replaceAll(/<[^>]+>/gu, '')).toContain('at least $148');
});

test('with no System paired, the card shows no figures', () => {
  const html = renderToStaticMarkup(
    <HomeVerdictCard
      figures={{ awake: 0, services: 0, servicesUp: 0, systems: 0 }}
      verdict={{ level: 'empty', sentence: 'No System is paired.', support: [] }}
    />,
  );

  expect(html).toContain('border-l-border');
  expect(html).not.toContain('<dl');
});
