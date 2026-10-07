import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { issueCode, unpair } from './pairing.ts';
import { NOW, page, push, redeem, report, startHub } from './testing/hub.ts';

type Hub = Awaited<ReturnType<typeof startHub>>;

const MINUTE = 60_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest();

// Issues a code for `system` at the Hub's current time.
const issue = async (h: Hub, system: string) =>
  (await issueCode(h.db.sql, { now: h.clock.now, system })).code;

// Redeems `code` and answers the System and token, failing the test otherwise.
const pairWith = async (h: Hub, code: string) => {
  const response = await redeem(h.hub, { code });
  expect(response.status).toBe(200);
  return (await response.json()) as { system: string; token: string };
};

const FAILURE = { error: 'invalid or expired code' };

// Asserts the one answer every failed redemption gets: status, every header, and body.
const expectFailure = async (response: Response) => {
  expect(response.status).toBe(400);
  expect([...response.headers]).toEqual([['content-type', 'application/json;charset=utf-8']]);
  expect(await response.text()).toBe(JSON.stringify(FAILURE));
};

test('a code redeems for its System and a new token, which authenticates Reports', async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');

  const response = await redeem(h.hub, { code });

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const { system, token } = (await response.json()) as { system: string; token: string };
  expect(system).toBe('desktop-1');
  // 32 random bytes, base64url without padding.
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect((await push(h.hub, report('desktop-1', [NOW]), { token })).status).toBe(200);
});

test('issuing answers when the code expires, 10 minutes later', async () => {
  await using h = await startHub();

  const issued = await issueCode(h.db.sql, { now: NOW, system: 'desktop-1' });

  expect(issued.expiresAt).toBe(NOW + 10 * MINUTE);
});

test('the Hub keeps only the hashes of codes and tokens', async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');
  const pending = await h.db.sql`SELECT * FROM pairing_codes WHERE system = 'desktop-1'`;
  expect(pending).toHaveLength(1);
  expect(JSON.stringify(pending)).not.toContain(code);
  expect(Buffer.from(pending[0].code_hash)).toEqual(sha256(code));

  const { token } = await pairWith(h, code);

  const paired = await h.db.sql`SELECT * FROM paired_systems WHERE system = 'desktop-1'`;
  expect(paired).toHaveLength(1);
  expect(JSON.stringify(paired)).not.toContain(token);
  expect(Buffer.from(paired[0].token_hash)).toEqual(sha256(token));
});

test('a code redeems in any case, with or without its dash, inside whitespace', async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');

  const { system } = await pairWith(h, ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)}\n`);

  expect(system).toBe('desktop-1');
});

test('a code redeems once', async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');
  await pairWith(h, code);

  await expectFailure(await redeem(h.hub, { code }));
});

test('a code redeems until 10 minutes after it was issued, and not from then on', async () => {
  await using h = await startHub();
  const kept = await issue(h, 'desktop-1');
  const late = await issue(h, 'desktop-2');

  h.clock.now = NOW + 10 * MINUTE - 1;
  await pairWith(h, kept);
  h.clock.now = NOW + 10 * MINUTE;

  await expectFailure(await redeem(h.hub, { code: late }));
});

test("a later code replaces the System's earlier one, and leaves other Systems' codes", async () => {
  await using h = await startHub();
  const first = await issue(h, 'desktop-1');
  const other = await issue(h, 'desktop-2');
  const second = await issue(h, 'desktop-1');

  await expectFailure(await redeem(h.hub, { code: first }));
  expect((await pairWith(h, second)).system).toBe('desktop-1');
  expect((await pairWith(h, other)).system).toBe('desktop-2');
});

test('a System pairs before the Hub has heard from it, and is not listed until it reports', async () => {
  await using h = await startHub();

  await pairWith(h, await issue(h, 'desktop-1'));

  expect(await page(h.hub)).toContain('No System has reported yet.');
});

test.each([
  ['a malformed code', { code: 'not-a-code' }],
  ['an unknown code', { code: 'ZZZZ-ZZZZ' }],
  ['a body without a code', {}],
  ['a code that is not a string', { code: 12_345_678 }],
  ['a body that is not JSON', '{"code":'],
  ['an empty body', ''],
  ['a JSON array', '["ZZZZ-ZZZZ"]'],
  ['JSON null', 'null'],
  ['fullwidth digits', { code: '\uFF17K3M-Q9XA' }],
  ['the letter I', { code: 'IK3M-Q9XA' }],
  ['the letter L', { code: 'LK3M-Q9XA' }],
  ['the letter O', { code: 'OK3M-Q9XA' }],
  ['a double dash', { code: '7K3M--Q9XA' }],
])('%s fails like any other failed redemption', async (_, body) => {
  await using h = await startHub();

  await expectFailure(await redeem(h.hub, body));
});

test('a body over the size cap fails like any other, even around a live code', async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');

  await expectFailure(await redeem(h.hub, { code, padding: 'x'.repeat(2048) }));
  expect((await pairWith(h, code)).system).toBe('desktop-1');
});

test.each([
  ['overstates', '999999'],
  ['understates', '4'],
])('a body whose Content-Length %s its size fails like any other', async (_, length) => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');
  const body = JSON.stringify({ code, padding: 'x'.repeat(2048) });

  const response = await h.hub.fetch(
    new Request('http://hub.test/api/v1/pair', {
      body,
      headers: { 'content-length': length, 'content-type': 'application/json' },
      method: 'POST',
    }),
  );

  await expectFailure(response);
});

test('an expired and a used code fail the same way as an unknown one', async () => {
  await using h = await startHub();
  const used = await issue(h, 'desktop-1');
  await pairWith(h, used);
  const expired = await issue(h, 'desktop-2');
  h.clock.now = NOW + 11 * MINUTE;

  await expectFailure(await redeem(h.hub, { code: used }));
  await expectFailure(await redeem(h.hub, { code: expired }));
});

// Fails `n` redemptions with a code no System holds.
const failTimes = async (h: Hub, n: number) => {
  for (let i = 0; i < n; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each failure lands before the next.
    await expectFailure(await redeem(h.hub, { code: 'ZZZZ-ZZZZ' }));
  }
};

test('after 10 failed redemptions in a minute, the Hub refuses even a good code', async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');
  await failTimes(h, 10);

  const refused = await redeem(h.hub, { code });

  expect(refused.status).toBe(429);
  expect(refused.headers.get('retry-after')).toBe('60');
  expect(await refused.json()).toEqual({ error: 'too many failed codes; try again later' });
  // The refusal did not spend the code.
  h.clock.elapsed += MINUTE;
  expect((await pairWith(h, code)).system).toBe('desktop-1');
});

test('the failure cap rolls: each failure stops counting a minute after it', async () => {
  await using h = await startHub();
  await failTimes(h, 5);
  h.clock.elapsed = 30_000;
  await failTimes(h, 5);
  expect((await redeem(h.hub, { code: 'ZZZZ-ZZZZ' })).status).toBe(429);

  h.clock.elapsed = MINUTE;
  await failTimes(h, 5);

  const refused = await redeem(h.hub, { code: 'ZZZZ-ZZZZ' });
  expect(refused.status).toBe(429);
  expect(refused.headers.get('retry-after')).toBe('30');
});

// The window runs on a monotonic clock, so a wall clock stepped back by NTP or
// an operator neither extends nor shortens a lockout. Codes still expire by the wall clock.
test('a wall clock stepped back does not extend the lockout', async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');
  await failTimes(h, 10);

  h.clock.now = NOW - 60 * MINUTE;
  h.clock.elapsed += MINUTE;

  expect((await pairWith(h, code)).system).toBe('desktop-1');
});

test('a wall clock stepped forward does not end the lockout early', async () => {
  await using h = await startHub();
  await failTimes(h, 10);

  h.clock.now = NOW + 60 * MINUTE;

  expect((await redeem(h.hub, { code: 'ZZZZ-ZZZZ' })).status).toBe(429);
});

test('successful redemptions do not count against the cap', async () => {
  await using h = await startHub();
  await failTimes(h, 9);
  for (const system of ['desktop-1', 'desktop-2', 'desktop-3']) {
    // oxlint-disable-next-line no-await-in-loop -- one pairing at a time.
    await pairWith(h, await issue(h, system));
  }

  await failTimes(h, 1);

  expect((await redeem(h.hub, { code: 'ZZZZ-ZZZZ' })).status).toBe(429);
});

test('redemptions in flight at once count against the cap together', async () => {
  await using h = await startHub();

  const responses = await Promise.all(
    Array.from({ length: 15 }, () => redeem(h.hub, { code: 'ZZZZ-ZZZZ' })),
  );

  const statuses = responses.map((r) => r.status).toSorted((a, b) => a - b);
  expect(statuses).toEqual([...Array(10).fill(400), ...Array(5).fill(429)]);
});

test('pairing again rotates the token: the old one works until the new code is redeemed', async () => {
  await using h = await startHub();
  const code = await issue(h, 'laptop-1');
  expect((await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' })).status).toBe(
    200,
  );

  const { token } = await pairWith(h, code);

  expect(
    (await push(h.hub, report('laptop-1', [NOW + 15_000]), { token: 'laptop-token' })).status,
  ).toBe(403);
  expect((await push(h.hub, report('laptop-1', [NOW + 15_000]), { token })).status).toBe(200);
});

test("unpairing revokes the System's token and keeps its history", async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

  expect(await unpair(h.db.sql, 'laptop-1')).toEqual({ revoked: true, withdrawn: false });

  expect((await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' })).status).toBe(
    403,
  );
  const html = await page(h.hub);
  expect(html).toContain('laptop-1');
  expect(html).toContain('0.1.0 darwin/arm64');
  expect((await push(h.hub, report('server-1', [NOW]), { token: 'server-token' })).status).toBe(
    200,
  );
});

test("unpairing withdraws the System's pending code", async () => {
  await using h = await startHub();
  const code = await issue(h, 'desktop-1');

  expect(await unpair(h.db.sql, 'desktop-1')).toEqual({ revoked: false, withdrawn: true });

  await expectFailure(await redeem(h.hub, { code }));
});

test('unpairing a System that is not paired changes nothing', async () => {
  await using h = await startHub();

  expect(await unpair(h.db.sql, 'desktop-1')).toEqual({ revoked: false, withdrawn: false });
});

test('issuing and redeeming clear away expired codes', async () => {
  await using h = await startHub();
  await issue(h, 'desktop-1');
  await issue(h, 'desktop-2');
  h.clock.now = NOW + 10 * MINUTE;
  await issue(h, 'desktop-3');

  const codes = await h.db.sql`SELECT system FROM pairing_codes ORDER BY system`;
  expect(codes).toEqual([{ system: 'desktop-3' }]);

  h.clock.now = NOW + 20 * MINUTE;
  await redeem(h.hub, { code: 'ZZZZ-ZZZZ' });
  const remaining: unknown[] = await h.db.sql`SELECT system FROM pairing_codes`;
  expect(remaining).toEqual([]);
});
