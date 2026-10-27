import { expect, test } from 'bun:test';

import type { UpdateManager } from '@heimdall/schema';

import { serviceUpdate, updatesOf } from './service-updates.ts';

const DAY = 86_400_000;
const NOW = 200 * DAY;

test('an update dates from the first newer release, even one later withdrawn', () => {
  expect(
    serviceUpdate({
      check: { checkedAt: NOW, failure: null, releases: { '': '1.3' }, succeededAt: NOW },
      now: NOW,
      releases: [
        { at: NOW - 3 * DAY, version: '1.1' },
        { at: NOW - DAY, version: '1.3' },
      ],
      upstream: 'github:owner/web',
      version: '1.0',
    }),
  ).toEqual({
    failure: undefined,
    status: { kind: 'update', since: NOW - 3 * DAY, source: 'upstream', version: '1.3' },
  });
});

test('dating an update ignores older releases and releases on other channels', () => {
  expect(
    serviceUpdate({
      check: { checkedAt: NOW, failure: null, releases: { '': '2.0' }, succeededAt: NOW },
      now: NOW,
      releases: [
        { at: NOW - 5 * DAY, version: '0.9' },
        { at: NOW - 4 * DAY, version: '1.0' },
        { at: NOW - 3 * DAY, version: '2.0-beta.1' },
        { at: NOW - DAY, version: '2.0' },
      ],
      upstream: 'npm:web',
      version: '1.0',
    }).status,
  ).toEqual({ kind: 'update', since: NOW - DAY, source: 'upstream', version: '2.0' });
});

test('a current release, an unreadable version, and missing knowledge stay distinct', () => {
  const check = { checkedAt: NOW, failure: null, releases: { '': '1.0' }, succeededAt: NOW };
  const base = { now: NOW, upstream: 'oci:registry/web' };
  expect(serviceUpdate({ ...base, check, version: '1.0' }).status).toEqual({ kind: 'current' });
  expect(serviceUpdate({ ...base, check, version: 'latest' }).status).toEqual({
    kind: 'unreadable',
    version: 'latest',
  });
  expect(serviceUpdate({ ...base, version: '1.0' }).status).toBeUndefined();
  expect(
    serviceUpdate({
      ...base,
      check: { ...check, releases: null, succeededAt: null },
      version: '1.0',
    }).status,
  ).toBeUndefined();
  expect(serviceUpdate({ ...base, check, version: '2.0' }).status).toBeUndefined();
  expect(serviceUpdate({ ...base, check, version: null }).status).toBeUndefined();
});

for (const succeededAt of [null, NOW - DAY]) {
  test(`a failed check keeps its answer and the last success ${String(succeededAt)}`, () => {
    expect(
      serviceUpdate({
        check: { checkedAt: NOW, failure: 'Rate limited', releases: { '': '2.0' }, succeededAt },
        now: NOW,
        upstream: 'github:owner/web',
        version: '1.0',
      }),
    ).toEqual({
      failure: { at: NOW, reason: 'Rate limited', succeededAt, upstream: 'github:owner/web' },
      status: { kind: 'update', since: undefined, source: 'upstream', version: '2.0' },
    });
  });
}

test('unrecognized or missing upstreams show nothing, even for unreadable versions', () => {
  for (const upstream of [null, 'owner/web']) {
    expect(serviceUpdate({ now: NOW, upstream, version: 'latest' })).toEqual({
      failure: undefined,
      status: undefined,
    });
  }
});

for (const [upstream, manager, name, source] of [
  ['apt:web', 'apt', 'web:amd64', 'APT'],
  ['brew:web', 'homebrew', 'formula:web', 'Homebrew'],
] as const) {
  test(`${upstream} uses a fresh package observation without a since time`, () => {
    const observation = {
      installation: '/',
      manager,
      observedAt: NOW,
      result: {
        kind: 'available',
        metadataAt: NOW,
        updates: [{ available: '2.0', installed: '1.0', name, security: null }],
      },
    } satisfies UpdateManager;
    const base = { now: NOW, observations: [observation], upstream, version: '1.0' };
    expect(serviceUpdate(base)).toEqual({
      failure: undefined,
      status: { kind: 'update', source, version: '2.0' },
    });
    expect(serviceUpdate({ ...base, now: NOW + 2 * DAY }).status).toBeUndefined();
    expect(serviceUpdate({ ...base, observations: [] }).status).toBeUndefined();
    expect(serviceUpdate({ ...base, version: null }).status).toBeUndefined();
  });
}

test('release history compares against what ran then, retaining rows after an upgrade', () => {
  expect(
    updatesOf({
      now: NOW,
      releases: [
        { at: NOW - 2 * DAY, version: '2.0' },
        { at: NOW - DAY, version: '3.0' },
      ],
      upstream: 'github:owner/web',
      versions: [
        { at: NOW - 3 * DAY, version: '1.0' },
        { at: NOW - DAY, version: '3.0' },
      ],
    }),
  ).toEqual([{ at: NOW - 2 * DAY, version: '2.0' }]);
});

test('history skips releases before a known install, outside the window, and on another channel', () => {
  const base = {
    now: NOW,
    releases: [
      { at: NOW - 100 * DAY, version: '2.0' },
      { at: NOW - 89 * DAY, version: '3.0' },
      { at: NOW - 2 * DAY, version: '4.0-beta' },
      { at: NOW - DAY, version: '4.0' },
    ],
    upstream: 'npm:web',
    versions: [
      { at: NOW - 88 * DAY, version: '1.0' },
      { at: NOW - 3 * DAY, version: null },
    ],
  };
  expect(updatesOf(base)).toEqual([{ at: NOW - DAY, version: '4.0' }]);
  for (const upstream of [null, 'apt:web', 'brew:web', 'owner/web']) {
    expect(updatesOf({ ...base, upstream })).toEqual([]);
  }
});

test('history includes the window boundary and skips older releases despite a known installed version', () => {
  expect(
    updatesOf({
      now: NOW,
      releases: [
        { at: NOW - 90 * DAY - 1, version: '1.1' },
        { at: NOW - 90 * DAY, version: '1.2' },
      ],
      upstream: 'oci:registry/web',
      versions: [{ at: NOW - 120 * DAY, version: '1.0' }],
    }),
  ).toEqual([{ at: NOW - 90 * DAY, version: '1.2' }]);
});
