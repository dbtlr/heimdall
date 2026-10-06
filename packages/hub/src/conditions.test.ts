import { expect, test } from 'bun:test';

import { NOW, page, push, report, startHub } from './testing/hub.ts';

// A Report the schema rejects: it carries no samples.
const invalid = (system: string) => ({ ...report(system, [NOW]), samples: [] });

// The page's two parts: the table of Systems, and every System's Timeline.
const sections = async (hub: Parameters<typeof page>[0]) => {
  const [systems = '', timeline = ''] = (await page(hub)).split('<h2>Timeline</h2>');
  return { systems, timeline };
};

const count = (text: string, part: string) => text.split(part).length - 1;

test('an invalid Report still counts as seeing its System', async () => {
  await using h = await startHub();
  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });
  h.clock.now = NOW + 60 * 60_000;

  const response = await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });

  expect(response.status).toBe(422);
  expect((await sections(h.hub)).systems).toContain('2026-10-06 13:00:00 UTC');
});

test("a Report naming another System counts as seeing the token's System, not the named one", async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('asgard', [NOW]), { token: 'mbp-token' });

  expect(response.status).toBe(403);
  const { systems } = await sections(h.hub);
  expect(systems).toContain('<td>db-mbp</td>');
  expect(systems).not.toContain('<td>asgard</td>');
});

test('requests without a known token see no System', async () => {
  await using h = await startHub();

  await push(h.hub, report('db-mbp', [NOW]));
  await push(h.hub, report('db-mbp', [NOW]), { token: 'guess' });

  expect(await page(h.hub)).toContain('No System has reported yet.');
});

test('a System heard only through rejections is listed with its status and no Vitals', async () => {
  await using h = await startHub();

  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });

  const { systems } = await sections(h.hub);
  expect(systems).toContain('db-mbp');
  expect(systems).toContain('2026-10-06 12:00:00 UTC');
  expect(systems).toContain('Reports rejected');
  expect(systems).not.toContain('GiB');
});

test('repeated rejections raise one Condition; the page shows the latest reason, the Timeline the first', async () => {
  await using h = await startHub();
  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });
  h.clock.now = NOW + 60_000;

  await push(h.hub, report('asgard', [NOW]), { token: 'mbp-token' });

  const { systems, timeline } = await sections(h.hub);
  expect(systems).toContain('This token belongs to db-mbp, not asgard.');
  expect(count(timeline, 'Reports rejected')).toBe(1);
  expect(timeline).toContain('samples');
  expect(timeline).not.toContain('not asgard');
});

test('a stored Report clears the Condition, and the Timeline shows when it was raised and cleared', async () => {
  await using h = await startHub();
  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });
  h.clock.now = NOW + 5 * 60_000;

  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });

  const { systems, timeline } = await sections(h.hub);
  expect(systems).not.toContain('Reports rejected');
  expect(systems).toContain('OK');
  const cleared = timeline.indexOf('Reports accepted again');
  const raised = timeline.indexOf('Reports rejected');
  // Newest first.
  expect(cleared).toBeGreaterThan(-1);
  expect(raised).toBeGreaterThan(cleared);
  expect(timeline).toContain('2026-10-06 12:05:00 UTC');
  expect(timeline).toContain('2026-10-06 12:00:00 UTC');
});

test('a rejection after recovery raises the Condition again', async () => {
  await using h = await startHub();
  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });
  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });

  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });

  const { systems, timeline } = await sections(h.hub);
  expect(systems).toContain('Reports rejected');
  expect(count(timeline, 'Reports rejected')).toBe(2);
  expect(count(timeline, 'Reports accepted again')).toBe(1);
});

test('a stored Report with no Condition open adds nothing to the Timeline', async () => {
  await using h = await startHub();

  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });

  const { timeline } = await sections(h.hub);
  expect(timeline).not.toContain('<li>');
});
