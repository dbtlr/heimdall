import { expect, test } from 'bun:test';

import { readIdentity } from './identity.ts';
import { reporterStore } from './run.ts';
import { givenIdentity, TOKEN } from './testing/cli.ts';
import { tempStateDir } from './testing/fixtures.ts';

// The reporter sends the held job runs only while the identity the daemon
// started with is still stored: a wrong check would send them to the wrong Hub
// after `pair`, or never send them at all (ADR-0023).
test("the daemon's reporter is told it is paired until pair stores another identity", async () => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path, { hub: 'http://h.example' });
  const read = await readIdentity(dir.path);
  if (read.kind !== 'paired') {
    throw new Error(`expected a paired identity, got ${read.kind}`);
  }
  const { paired } = reporterStore({
    hub: new URL('http://h.example/heimdall/'),
    identity: read.identity,
    stateDir: dir.path,
  });

  expect(await paired()).toBe(true);

  await givenIdentity(dir.path, { hub: 'http://h.example', token: `${TOKEN}-again` });

  expect(await paired()).toBe(false);
});
