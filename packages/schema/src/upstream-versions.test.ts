import { expect, test } from 'bun:test';

import { FUTURE_SAMPLE_TOLERANCE_MS } from './conditions.ts';
import type { UpdateManager } from './updates-section.ts';
import { UPDATE_METADATA_MAX_AGE_MS, UPDATE_OBSERVATION_MAX_AGE_MS } from './updates-section.ts';
import {
  availableUpdate,
  newestPerChannel,
  packageAvailableVersion,
  packageMatchesUpstream,
  parseVersion,
} from './upstream-versions.ts';

test('loose versions retain their numeric core, channel, and suffix numbers', () => {
  expect(parseVersion('0.26.0-next.32')).toEqual({
    channel: 'next.#',
    core: [0, 26, 0],
    numbers: [32],
  });
  expect(parseVersion('16-alpine')).toEqual({ channel: 'alpine', core: [16], numbers: [] });
  expect(parseVersion('1.27-alpine3.20')).toEqual({
    channel: 'alpine#.#',
    core: [1, 27],
    numbers: [3, 20],
  });
  expect(parseVersion('1.27-alpine3.20-perl')).toEqual({
    channel: 'alpine#.#-perl',
    core: [1, 27],
    numbers: [3, 20],
  });
  expect(parseVersion('v1.2+build.42')).toEqual({ channel: null, core: [1, 2], numbers: [] });
  expect(parseVersion('V1.2.3.4-rc.1+build')).toEqual({
    channel: 'rc.#',
    core: [1, 2, 3, 4],
    numbers: [1],
  });
});

test.each([
  'latest',
  '',
  '1..2',
  '1.2-',
  '1.x',
  '1\n',
  '1-rc..1',
  '9007199254740993',
  '1-rc.9007199254740993',
  // A date, a build number, or a commit hash made only of digits.
  '12345',
])('an unreadable version cannot be parsed: %j', (version) => {
  expect(parseVersion(version)).toBeUndefined();
});

test('each channel keeps its newest readable release and skips moving tags', () => {
  expect(
    newestPerChannel(
      new Set(['latest', '0.26.0-next.32', '0.26.0-next.35', '16-alpine', '16.1-alpine', '17']),
    ),
  ).toEqual({ '': '17', alpine: '16.1-alpine', 'next.#': '0.26.0-next.35' });
  expect(newestPerChannel(['latest', 'stable'])).toEqual({});
});

test('equal precedence preserves the first release string', () => {
  expect(newestPerChannel(['v1.2+first', '1.2.0+second'])).toEqual({ '': 'v1.2+first' });
  expect(newestPerChannel(['1', '1.0', '1.0.0'])).toEqual({ '': '1' });
});

test.each([
  ['1.2.3', '1.2.3.4', '1.2.3.4'],
  ['1-rc.9', '1-rc.10', '1-rc.10'],
  ['1-rc.01', '1-rc.1', '1-rc.01'],
  ['1-alpine3.9', '1-alpine3.10', '1-alpine3.10'],
  ['1.27.2-alpine3.20', '1.27.1-alpine3.21', '1.27.2-alpine3.20'],
])('release precedence orders %s and %s', (first, second, expected) => {
  expect(Object.values(newestPerChannel([first, second]))).toEqual([expected]);
});

test('a suffix of another shape is another channel, never a step on this one', () => {
  expect(
    newestPerChannel([
      '1.27.2-alpine3.20',
      '1.27.3-alpine3.20-perl',
      '1.27.3-alpine3.21',
      '1-rc',
      '1-rc.2',
      '1-rc.a',
    ]),
  ).toEqual({
    'alpine#.#': '1.27.3-alpine3.21',
    'alpine#.#-perl': '1.27.3-alpine3.20-perl',
    rc: '1-rc',
    'rc.#': '1-rc.2',
    'rc.a': '1-rc.a',
  });
});

test('channel names that also name object properties remain ordinary channels', () => {
  expect(newestPerChannel(['1-constructor', '2-constructor', '1-toString'])).toEqual({
    constructor: '2-constructor',
    toString: '1-toString',
  });
});

test.each([
  ['0.26.0-next.32', ['0.26.0-next.35'], '0.26.0-next.35'],
  ['16-alpine', ['16.1-alpine'], '16.1-alpine'],
  ['16-alpine', ['17'], '17'],
  ['v1.2', ['1.2.1+build'], '1.2.1+build'],
  ['16-alpine', ['16.1-alpine', '17'], '17'],
  ['16-alpine', ['18-alpine', '17'], '18-alpine'],
  // On equal numbers the install's own label wins, so no update moves it off its variant.
  ['16-alpine', ['17-alpine', '17'], '17-alpine'],
  ['1.27.2-alpine3.20', ['1.27.3-alpine3.20-perl', '1.27.3-alpine3.21'], '1.27.3-alpine3.21'],
])(
  'an available update for %s chooses the newest eligible candidate',
  (installed, releases, version) => {
    expect(availableUpdate(installed, newestPerChannel(releases))).toEqual({
      kind: 'update',
      version,
    });
  },
);

test.each([
  ['16-alpine', ['16', '15.9']],
  ['1.0.0-rc.1', ['1.0.0']],
  ['1', ['2-beta.1']],
  ['1-rc.1', ['2-beta.1']],
  ['2', ['1']],
  ['1', []],
  ['1-constructor', []],
])('an unmatched installed version %s is unknown rather than current', (installed, releases) => {
  expect(availableUpdate(installed, newestPerChannel(releases))).toEqual({ kind: 'unknown' });
});

test.each([
  ['v1.2+installed', ['1.2.0+released', '2-beta.1']],
  ['1', ['1.0.0']],
  ['16-alpine', ['16-alpine', '16']],
  ['1.0.0-rc.01', ['1-rc.1', '1']],
  ['1.7.2', ['1.7.2', '1.8.0-alpha.1']],
  ['1.4.2', ['1.4.2', '20261027']],
  ['9999', ['9999', '20261027']],
])('a matching newest release establishes that %s is current', (installed, releases) => {
  expect(availableUpdate(installed, newestPerChannel(releases))).toEqual({ kind: 'current' });
});

test.each([null, 'latest'])('an installed version %j cannot be compared', (installed) => {
  expect(availableUpdate(installed, newestPerChannel(['100']))).toEqual({ kind: 'unreadable' });
});

test.each([
  ['apt:nginx', 'nginx:amd64', true],
  ['apt:nginx', 'nginx:', false],
  ['apt:nginx', 'nginx-full:amd64', false],
  ['apt:nginx', 'nginx', false],
  ['brew:nginx', 'formula:nginx', true],
  ['brew:nginx', 'cask:nginx', true],
  ['brew:nginx', 'formula:nginx-full', false],
  ['brew:nginx', 'nginx', false],
  ['npm:nginx', 'nginx', false],
])('package identity %s matches %s: %s', (upstream, packageName, matches) => {
  expect(packageMatchesUpstream(upstream, packageName)).toBe(matches);
});

const now = 10 * UPDATE_METADATA_MAX_AGE_MS;
const observation = (overrides: Partial<UpdateManager> = {}): UpdateManager => ({
  installation: '/mock/manager',
  manager: 'apt',
  observedAt: now,
  result: {
    kind: 'available',
    metadataAt: now,
    updates: [{ available: '2', installed: '1', name: 'nginx:amd64', security: null }],
  },
  ...overrides,
});

test('APT uses the first matching pending update, regardless of architecture', () => {
  const apt = observation({
    result: {
      kind: 'available',
      metadataAt: now,
      updates: [
        { available: '99', installed: '1', name: 'nginx-full:amd64', security: null },
        { available: '98', installed: '1', name: 'nginx:', security: null },
        { available: '2', installed: '1', name: 'nginx:arm64', security: null },
        { available: '3', installed: '1', name: 'nginx:amd64', security: null },
      ],
    },
  });
  expect(packageAvailableVersion('apt:nginx', [apt, observation()], now)).toBe('2');
  expect(packageAvailableVersion('apt:other', [apt], now)).toBeNull();
});

test.each(['cask:nginx'])('Homebrew reads pending updates for %s', (name) => {
  const brew = observation({
    manager: 'homebrew',
    result: {
      kind: 'available',
      metadataAt: now,
      updates: [{ available: '3', installed: '1', name, security: null }],
    },
  });
  expect(packageAvailableVersion('brew:nginx', [observation(), brew], now)).toBe('3');
  expect(packageAvailableVersion('apt:nginx', [brew], now)).toBeNull();
});

test('pending updates require fresh observations and fresh known metadata from the right manager', () => {
  const unavailable: UpdateManager[] = [
    observation({ observedAt: now - UPDATE_OBSERVATION_MAX_AGE_MS - 1 }),
    observation({ observedAt: now + FUTURE_SAMPLE_TOLERANCE_MS + 1 }),
    observation({ result: { kind: 'unavailable', reason: 'cannot read metadata' } }),
    observation({
      result: {
        kind: 'available',
        metadataAt: null,
        updates: [{ available: '2', installed: '1', name: 'nginx:amd64', security: null }],
      },
    }),
    observation({
      result: {
        kind: 'available',
        metadataAt: now - UPDATE_METADATA_MAX_AGE_MS - 1,
        updates: [{ available: '2', installed: '1', name: 'nginx:amd64', security: null }],
      },
    }),
    observation({
      result: {
        kind: 'available',
        metadataAt: now + FUTURE_SAMPLE_TOLERANCE_MS + 1,
        updates: [{ available: '2', installed: '1', name: 'nginx:amd64', security: null }],
      },
    }),
    observation({ manager: 'homebrew' }),
    observation({ manager: 'macos' }),
  ];
  for (const manager of unavailable) {
    expect(packageAvailableVersion('apt:nginx', [manager], now)).toBeNull();
  }
  expect(packageAvailableVersion('apt:nginx', [...unavailable, observation()], now)).toBe('2');
});

test('observation and metadata freshness include their exact age and future tolerance boundaries', () => {
  const boundary = observation({
    observedAt: now - UPDATE_OBSERVATION_MAX_AGE_MS,
    result: {
      kind: 'available',
      metadataAt: now - UPDATE_METADATA_MAX_AGE_MS,
      updates: [{ available: '2', installed: '1', name: 'nginx:amd64', security: null }],
    },
  });
  expect(packageAvailableVersion('apt:nginx', [boundary], now)).toBe('2');
  expect(
    packageAvailableVersion(
      'apt:nginx',
      [
        observation({
          observedAt: now + FUTURE_SAMPLE_TOLERANCE_MS,
          result: {
            kind: 'available',
            metadataAt: now + FUTURE_SAMPLE_TOLERANCE_MS,
            updates: [{ available: '2', installed: '1', name: 'nginx:amd64', security: null }],
          },
        }),
      ],
      now,
    ),
  ).toBe('2');
});

test('a null available value is retained rather than replaced by a later match', () => {
  const unknownVersion = observation({
    result: {
      kind: 'available',
      metadataAt: now,
      updates: [{ available: null, installed: '1', name: 'nginx:amd64', security: null }],
    },
  });
  expect(packageAvailableVersion('apt:nginx', [unknownVersion, observation()], now)).toBeNull();
});

test('package coverage without a pending update returns null; other upstream kinds return undefined', () => {
  expect(packageAvailableVersion('apt:nginx', [], now)).toBeNull();
  expect(packageAvailableVersion('brew:nginx', [], now)).toBeNull();
  expect(
    packageAvailableVersion(
      'apt:nginx',
      [observation({ result: { kind: 'available', metadataAt: now, updates: [] } })],
      now,
    ),
  ).toBeNull();
  expect(packageAvailableVersion('github:owner/repo', [observation()], now)).toBeUndefined();
});
