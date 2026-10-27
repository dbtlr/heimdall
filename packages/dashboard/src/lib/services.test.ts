import { describe, expect, test } from 'bun:test';

import {
  filterServices,
  serviceFilterCounts,
  servicesSearch,
  serviceStatus,
  sortServices,
} from './services.ts';
import type { ServiceSummary } from './services.ts';

describe('Service status', () => {
  test('an open Service down wins over a restart note and passing checks', () => {
    expect(serviceStatus({ checks: [{ state: 'up' }], downSince: 10, restarted: true })).toBe(
      'down',
    );
    expect(serviceStatus({ checks: [], downSince: 0, restarted: false })).toBe('down');
  });

  test('an open restart note wins over checks when Service down is closed', () => {
    expect(serviceStatus({ checks: [], downSince: undefined, restarted: true })).toBe('restarted');
  });

  test('only a nonempty set of entirely passing checks is up', () => {
    for (const checks of [
      [],
      [{ state: 'unknown' }],
      [{ state: 'unchecked' }],
      [{ state: 'up' }, { state: 'down' }],
    ]) {
      expect(serviceStatus({ checks, downSince: undefined, restarted: false })).toBe('unknown');
    }
    expect(
      serviceStatus({
        checks: [{ state: 'up' }, { state: 'up' }],
        downSince: undefined,
        restarted: false,
      }),
    ).toBe('up');
  });
});

const rows: ServiceSummary[] = [
  {
    downSince: undefined,
    latestStopAt: undefined,
    name: 'web',
    status: 'up',
    system: 'alpha',
    update: undefined,
    version: null,
  },
  {
    downSince: 1,
    latestStopAt: undefined,
    name: 'web',
    status: 'down',
    system: 'beta',
    update: undefined,
    version: null,
  },
  {
    downSince: undefined,
    latestStopAt: 2,
    name: 'cache',
    status: 'restarted',
    system: 'alpha',
    update: undefined,
    version: null,
  },
  {
    downSince: undefined,
    latestStopAt: undefined,
    name: 'worker',
    status: 'unknown',
    system: 'beta',
    update: undefined,
    version: null,
  },
  {
    downSince: 1,
    latestStopAt: undefined,
    name: 'api',
    status: 'down',
    system: 'beta',
    update: undefined,
    version: null,
  },
  {
    downSince: 1,
    latestStopAt: undefined,
    name: 'api',
    status: 'down',
    system: 'alpha',
    update: undefined,
    version: null,
  },
];

test('Services sort worst first, then by Service name and System name', () => {
  expect(sortServices(rows).map(({ name, system }) => `${system}/${name}`)).toEqual([
    'alpha/api',
    'beta/api',
    'beta/web',
    'alpha/cache',
    'alpha/web',
    'beta/worker',
  ]);
  expect(rows[0]?.status).toBe('up');
});

test('filters OR within a section and AND between sections; empty means all', () => {
  expect(filterServices(rows, { status: [], system: [] })).toHaveLength(6);
  expect(filterServices(rows, { status: ['down', 'up'], system: ['alpha', 'beta'] })).toHaveLength(
    4,
  );
  expect(
    filterServices(rows, { status: ['down', 'restarted'], system: ['alpha'] }).map(
      ({ status }) => status,
    ),
  ).toEqual(['restarted', 'down']);
  expect(filterServices(rows, { status: [], system: ['missing'] })).toEqual([]);
});

test('chip counts use only the other section, including zero and multi-select', () => {
  const counts = serviceFilterCounts(rows, { status: ['up', 'restarted'], system: ['beta'] });
  expect(counts.status).toEqual({ down: 2, restarted: 0, unknown: 1, up: 0, updates: 0 });
  expect(counts.system).toEqual({ alpha: 2, beta: 0 });
  expect(serviceFilterCounts(rows, { status: [], system: ['alpha', 'beta'] }).status).toEqual({
    down: 3,
    restarted: 1,
    unknown: 1,
    up: 1,
    updates: 0,
  });
});

test('search validation drops unknown statuses and non-string System values and deduplicates arrays', () => {
  expect(
    servicesSearch({ status: ['down', 'bad', 'up', 'down'], system: ['alpha', 1, 'alpha'] }),
  ).toEqual({ status: ['down', 'up'], system: ['alpha'] });
  expect(servicesSearch({ status: 'down', system: null })).toEqual({
    status: ['down'],
    system: undefined,
  });
});

for (const [search, expected] of [
  [{ status: 'down' }, { status: ['down'], system: undefined }],
  [{ system: 'web-1' }, { status: undefined, system: ['web-1'] }],
  [{ system: 123 }, { status: undefined, system: ['123'] }],
  [
    { status: 'bad', system: Infinity },
    { status: undefined, system: undefined },
  ],
  [
    { status: [], system: [] },
    { status: undefined, system: undefined },
  ],
] satisfies [Parameters<typeof servicesSearch>[0], ReturnType<typeof servicesSearch>][]) {
  test(`search accepts single values and omits empty selections: ${JSON.stringify(search)}`, () => {
    expect(servicesSearch(search ?? {})).toEqual(expected);
  });
}

test('Updates matches independently of status and sections constrain each other’s counts', () => {
  const services = rows.map((row) => ({
    ...row,
    update: row.name === 'cache' || row.name === 'worker' ? '2.0' : undefined,
  }));
  expect(
    filterServices(services, { status: ['updates'], system: [] }).map(({ name }) => name),
  ).toEqual(['cache', 'worker']);
  expect(
    filterServices(services, { status: ['restarted', 'updates'], system: ['alpha'] }).map(
      ({ name }) => name,
    ),
  ).toEqual(['cache']);
  expect(serviceFilterCounts(services, { status: ['updates'], system: ['alpha'] })).toEqual({
    status: { down: 1, restarted: 1, unknown: 0, up: 1, updates: 1 },
    system: { alpha: 1, beta: 1 },
  });
  expect(servicesSearch({ status: 'updates' })).toEqual({ status: ['updates'], system: undefined });
});

test('updates rank after down and restarted, ahead of up and unknown', () => {
  const services = structuredClone(rows);
  for (const row of services) {
    row.update = ['worker', 'cache', 'api'].includes(row.name) ? '2.0' : undefined;
  }
  expect(sortServices(services).map(({ status }) => status)).toEqual([
    'down',
    'down',
    'down',
    'restarted',
    'unknown',
    'up',
  ]);
});

test('a restarted Service without an update ranks before an up Service with an earlier name and an update', () => {
  const base = {
    downSince: undefined,
    latestStopAt: undefined,
    system: 'alpha',
    version: '1.0',
  };
  expect(
    sortServices([
      { ...base, name: 'api', status: 'up', update: '2.0' },
      { ...base, name: 'web', status: 'restarted', update: undefined },
    ]).map(({ name }) => name),
  ).toEqual(['web', 'api']);
});
