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
  expect(systems).not.toContain('darwin');
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
  expect(systems).toContain('No open Conditions');
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

// The Timeline section of one System.
const timelineOf = (timeline: string, system: string) =>
  timeline.split('<h3>').find((part) => part.startsWith(`${system}</h3>`)) ?? '';

test("one System's Reports neither clear nor show another System's Conditions", async () => {
  await using h = await startHub();
  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });

  await push(h.hub, report('asgard', [NOW]), { token: 'asgard-token' });

  const { systems, timeline } = await sections(h.hub);
  const rowOf = (system: string) =>
    systems.split('<tr>').find((r) => r.startsWith(`<td>${system}</td>`)) ?? '';
  expect(rowOf('db-mbp')).toContain('Reports rejected');
  expect(rowOf('asgard')).toContain('No open Conditions');
  expect(timelineOf(timeline, 'asgard')).toContain('No Conditions yet.');
  expect(timelineOf(timeline, 'db-mbp')).toContain('Reports rejected');
});

test('a rejection the Hub clock places earlier does not move last seen back', async () => {
  await using h = await startHub();
  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });
  h.clock.now = NOW - 60 * 60_000;

  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });

  expect((await sections(h.hub)).systems).toContain('2026-10-06 12:00:00 UTC');
});

test('a Condition is never cleared before it was raised, even when the Hub clock steps back', async () => {
  await using h = await startHub();
  h.clock.now = NOW + 60 * 60_000;
  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });
  h.clock.now = NOW;

  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });

  const { timeline } = await sections(h.hub);
  expect(timeline).not.toContain('2026-10-06 12:00:00 UTC');
  expect(count(timeline, '2026-10-06 13:00:00 UTC')).toBe(2);
});

test('the latest rejection to arrive sets the reason, whatever the Hub clock says', async () => {
  await using h = await startHub();
  h.clock.now = NOW + 60_000;
  await push(h.hub, 'garbage', { token: 'mbp-token' });
  h.clock.now = NOW;

  await push(h.hub, report('asgard', [NOW]), { token: 'mbp-token' });

  expect((await sections(h.hub)).systems).toContain('This token belongs to db-mbp, not asgard.');
});

test("the Timeline shows each System's latest 10 Conditions, and the status every open one", async () => {
  await using h = await startHub();
  await push(h.hub, invalid('asgard'), { token: 'asgard-token' });
  for (let i = 0; i < 11; i += 1) {
    h.clock.now = NOW + i * 60_000;
    // oxlint-disable-next-line no-await-in-loop -- each Condition is raised and cleared in turn.
    await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });
    // oxlint-disable-next-line no-await-in-loop -- as above.
    await push(h.hub, report('db-mbp', [NOW + i]), { token: 'mbp-token' });
  }
  // The clock steps back: the open Condition sorts below older ones by time.
  h.clock.now = NOW - 60_000;
  await push(h.hub, 'garbage', { token: 'mbp-token' });

  const { systems, timeline } = await sections(h.hub);
  const mbp = timelineOf(timeline, 'db-mbp');
  expect(count(mbp, 'Reports rejected')).toBe(10);
  expect(mbp).toContain('2026-10-06 12:10:00 UTC');
  expect(mbp).not.toContain('2026-10-06 12:00:00 UTC');
  expect(timelineOf(timeline, 'asgard')).toContain('Reports rejected');
  expect(systems).toContain('The Report is not JSON.');
  expect(timeline).toContain('latest 10 Conditions');
});

test('reasons are escaped on the page and the Timeline', async () => {
  await using h = await startHub();

  await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });

  const html = await page(h.hub);
  expect(html).toContain('&gt;=1');
  expect(html).not.toContain('>=1');
});

test('a rejection the database cannot record is still answered as rejected', async () => {
  await using h = await startHub();
  await h.db.sql.close();

  const invalidReport = await push(h.hub, invalid('db-mbp'), { token: 'mbp-token' });
  const otherSystem = await push(h.hub, report('asgard', [NOW]), { token: 'mbp-token' });

  expect(invalidReport.status).toBe(422);
  expect(otherSystem.status).toBe(403);
  expect(h.errors).toHaveLength(2);
});
