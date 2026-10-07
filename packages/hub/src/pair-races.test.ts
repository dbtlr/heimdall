import { expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { issueCode, unpair } from './pairing.ts';
import { NOW, push, redeem, report, startHub } from './testing/hub.ts';

// These tests interleave transactions deterministically. A trigger makes each
// transaction that fires it wait on an advisory lock that a reserved
// connection holds, so the test can line other transactions up behind it,
// watch them block, and then let everything go.
const PAUSE_KEY = 727_001;

// Pauses every transaction right after it fires `event` on `table`, holding
// the row locks it has taken, until `release`.
const pauseAfter = async (sql: SQL, event: 'DELETE' | 'UPDATE', table: string) => {
  await sql.unsafe(`
    CREATE FUNCTION pause() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN PERFORM pg_advisory_xact_lock(${String(PAUSE_KEY)}); RETURN NULL; END $$
  `);
  await sql.unsafe(`
    CREATE TRIGGER pause AFTER ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION pause()
  `);
  const holder = await sql.reserve();
  await holder`SELECT pg_advisory_lock(${PAUSE_KEY})`;
  return {
    release: async () => {
      await holder`SELECT pg_advisory_unlock(${PAUSE_KEY})`;
      holder.release();
    },
  };
};

// Waits until `n` sessions on this database wait for a lock.
const waitForBlocked = async (sql: SQL, n: number) => {
  const deadline = Date.now() + 5000;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polls until the sessions block.
    const [row]: { n: number }[] = await sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if ((row?.n ?? 0) >= n) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Only ${String(row?.n ?? 0)} of ${String(n)} sessions blocked.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until the sessions block.
    await Bun.sleep(10);
  }
};

const tokenOf = async (response: Response) => ((await response.json()) as { token: string }).token;

// Unpair takes the code row first. Racing a redemption, it waits for the
// redemption to commit and then revokes the token the redemption stored.
test("unpair racing a redemption of the System's code leaves no live token and says so", async () => {
  await using h = await startHub();
  const { code } = await issueCode(h.db.sql, { now: NOW, system: 'desktop-1' });
  const pause = await pauseAfter(h.db.sql, 'DELETE', 'pairing_codes');

  const redeeming = redeem(h.hub, { code });
  await waitForBlocked(h.db.sql, 1);
  const unpairing = unpair(h.db.sql, 'desktop-1');
  await waitForBlocked(h.db.sql, 2);
  await pause.release();
  const [response, result] = await Promise.all([redeeming, unpairing]);

  expect(response.status).toBe(200);
  expect(result).toEqual({ revoked: true, withdrawn: false });
  const token = await tokenOf(response);
  expect((await push(h.hub, report('desktop-1', [NOW]), { token })).status).toBe(403);
  expect(h.errors).toEqual([]);
});

// Taking the code row before the token row, as redemption does, leaves no
// lock-order cycle between the two.
test('unpair of a paired System racing redemption of its re-pair code does not deadlock', async () => {
  await using h = await startHub();
  const { code } = await issueCode(h.db.sql, { now: NOW, system: 'laptop-1' });
  const pause = await pauseAfter(h.db.sql, 'DELETE', 'pairing_codes');

  const redeeming = redeem(h.hub, { code });
  await waitForBlocked(h.db.sql, 1);
  const unpairing = unpair(h.db.sql, 'laptop-1');
  await waitForBlocked(h.db.sql, 2);
  await pause.release();
  const [response, result] = await Promise.all([redeeming, unpairing]);

  expect(response.status).toBe(200);
  expect(result).toEqual({ revoked: true, withdrawn: false });
  const token = await tokenOf(response);
  for (const each of ['laptop-token', token]) {
    // oxlint-disable-next-line no-await-in-loop -- one Report at a time.
    expect((await push(h.hub, report('laptop-1', [NOW]), { token: each })).status).toBe(403);
  }
  expect(h.errors).toEqual([]);
});

test.each([[2], [3]])('%i redemptions of one code at once pair exactly once', async (n) => {
  await using h = await startHub();
  const { code } = await issueCode(h.db.sql, { now: NOW, system: 'desktop-1' });
  const pause = await pauseAfter(h.db.sql, 'DELETE', 'pairing_codes');

  const redeeming = Array.from({ length: n }, () => redeem(h.hub, { code }));
  await waitForBlocked(h.db.sql, n);
  await pause.release();
  const responses = await Promise.all(redeeming);

  const statuses = responses.map((r) => r.status).toSorted((a, b) => a - b);
  expect(statuses).toEqual([200, ...Array<number>(n - 1).fill(400)]);
  const tokens: unknown[] = await h.db.sql`SELECT 1 FROM paired_systems WHERE system = 'desktop-1'`;
  expect(tokens).toHaveLength(1);
});

// Issuing and redeeming serialize on the System's code row. Once a new code's
// issue commits, the code it replaced redeems nothing. A redemption that
// commits first keeps its token only until the new code is redeemed.
test('a redemption that waits on a new code for its System fails, and the new code redeems', async () => {
  await using h = await startHub();
  const { code: superseded } = await issueCode(h.db.sql, { now: NOW, system: 'desktop-1' });
  const pause = await pauseAfter(h.db.sql, 'UPDATE', 'pairing_codes');

  const issuing = issueCode(h.db.sql, { now: NOW, system: 'desktop-1' });
  await waitForBlocked(h.db.sql, 1);
  const redeeming = redeem(h.hub, { code: superseded });
  await waitForBlocked(h.db.sql, 2);
  await pause.release();
  const [{ code: replacement }, response] = await Promise.all([issuing, redeeming]);

  expect(response.status).toBe(400);
  expect((await redeem(h.hub, { code: replacement })).status).toBe(200);
});

test('a redemption that a new code waits on pairs, and the new code then rotates its token', async () => {
  await using h = await startHub();
  const { code: superseded } = await issueCode(h.db.sql, { now: NOW, system: 'desktop-1' });
  const pause = await pauseAfter(h.db.sql, 'DELETE', 'pairing_codes');

  const redeeming = redeem(h.hub, { code: superseded });
  await waitForBlocked(h.db.sql, 1);
  const issuing = issueCode(h.db.sql, { now: NOW, system: 'desktop-1' });
  await waitForBlocked(h.db.sql, 2);
  await pause.release();
  const [response, issued] = await Promise.all([redeeming, issuing]);

  expect(response.status).toBe(200);
  expect(issued.paired).toBe(true);
  const first = await tokenOf(response);
  expect((await push(h.hub, report('desktop-1', [NOW]), { token: first })).status).toBe(200);
  const second = await tokenOf(await redeem(h.hub, { code: issued.code }));
  expect((await push(h.hub, report('desktop-1', [NOW + 1]), { token: first })).status).toBe(403);
  expect((await push(h.hub, report('desktop-1', [NOW + 2]), { token: second })).status).toBe(200);
});
