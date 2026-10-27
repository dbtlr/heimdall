import { expect, test } from 'bun:test';

import type { ApplicationRecord, ChecksSection, ServiceRecord } from '@heimdall/schema';

import { NOW, push, report, startHub } from './testing/hub.ts';

const APPLICATION: ApplicationRecord = { name: 'nginx', source: 'apt:nginx', version: '1.26' };
const SERVICE: ServiceRecord = { application: 'nginx', name: 'web', supervisor: 'none' };
const DOCKER: ServiceRecord = { container: 'web', name: 'web', supervisor: 'docker' };
const SUPERVISOR = {
  check: 'supervisor',
  detail: '',
  image: 'nginx:1.27',
  service: 'web',
  since: NOW,
  state: 'up',
};

const records = (
  application: ApplicationRecord = APPLICATION,
  service: ServiceRecord = SERVICE,
) => ({
  records: [
    { kind: 'application', name: application.name, record: application },
    { kind: 'service', name: service.name, record: service },
  ],
  unreadable: [],
});

test.each([
  ['no checks section', undefined],
  ['no services part', {}],
  ['empty services', { services: [] }],
  ['health check only', { services: [{ ...SUPERVISOR, check: 'health' }] }],
  ['another Service', { services: [{ ...SUPERVISOR, service: 'other' }] }],
  ['services over budget', { overBudget: { services: { bytes: 2000000 } } }],
] satisfies [string, ChecksSection | undefined][])(
  'a Docker Service with %s writes nothing',
  async (_, checks) => {
    await using h = await startHub();
    expect(
      (
        await push(
          h.hub,
          { ...report('laptop-1', [NOW]), checks, records: records(APPLICATION, DOCKER) },
          { token: 'laptop-token' },
        )
      ).status,
    ).toBe(200);
    expect(await h.db.sql<Record<string, unknown>[]>`SELECT * FROM service_versions`).toEqual([]);
  },
);

test('checks alone record Docker tag changes and explicit unknowns, but missing checks preserve history', async () => {
  await using h = await startHub();
  expect(
    (
      await push(
        h.hub,
        { ...report('laptop-1', [NOW]), records: records(APPLICATION, DOCKER) },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await push(
        h.hub,
        { ...report('laptop-1', [NOW]), checks: { services: [SUPERVISOR] } },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);

  h.clock.now += 1000;
  expect(
    (await push(h.hub, { ...report('laptop-1', [NOW]), checks: {} }, { token: 'laptop-token' }))
      .status,
  ).toBe(200);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT version, upstream FROM service_versions`,
  ).toEqual([{ upstream: 'oci:docker.io/library/nginx', version: '1.27' }]);

  h.clock.now += 1000;
  expect(
    (
      await push(
        h.hub,
        {
          ...report('laptop-1', [NOW]),
          checks: { services: [{ ...SUPERVISOR, image: undefined, state: 'unknown' }] },
        },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT version, upstream, first_seen_at FROM service_versions ORDER BY first_seen_at`,
  ).toEqual([
    { first_seen_at: new Date(NOW), upstream: 'oci:docker.io/library/nginx', version: '1.27' },
    { first_seen_at: new Date(NOW + 2000), upstream: null, version: null },
  ]);
});

test('updates alone supersede the recorded version using this System census', async () => {
  await using h = await startHub();
  expect(
    (
      await push(
        h.hub,
        { ...report('laptop-1', [NOW]), records: records() },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  h.clock.now += 1000;
  expect(
    (
      await push(
        h.hub,
        {
          ...report('laptop-1', [NOW]),
          updates: {
            managers: [
              {
                installation: '/',
                installed: {
                  names: ['nginx:arm64'],
                  observedAt: NOW,
                  versions: [{ name: 'nginx:arm64', version: '1.28' }],
                },
                manager: 'apt',
                observedAt: NOW,
                result: { kind: 'available', metadataAt: NOW, updates: [] },
              },
            ],
            reboot: { kind: 'available', observedAt: NOW, required: false },
          },
        },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT version, upstream FROM service_versions ORDER BY first_seen_at`,
  ).toEqual([
    { upstream: 'apt:nginx', version: '1.26' },
    { upstream: 'apt:nginx', version: '1.28' },
  ]);
});

test('upstream changes at the same instant keep the later value in one row', async () => {
  await using h = await startHub();
  const body = { ...report('laptop-1', [NOW]), records: records() };
  expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
  expect(
    (
      await push(
        h.hub,
        { ...body, records: records({ ...APPLICATION, source: 'custom:nginx' }) },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT version, upstream FROM service_versions`,
  ).toEqual([{ upstream: 'custom:nginx', version: '1.26' }]);
});

test('an unknown version is stored once, and forgotten Services retain their history', async () => {
  await using h = await startHub();
  const body = {
    ...report('laptop-1', [NOW]),
    records: { records: [{ kind: 'service', name: 'web', record: SERVICE }], unreadable: [] },
  };
  expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
  h.clock.now += 1000;
  expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
  h.clock.now += 1000;
  expect(
    (
      await push(
        h.hub,
        { ...body, records: { records: [], unreadable: [] } },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT version, upstream, first_seen_at FROM service_versions`,
  ).toEqual([{ first_seen_at: new Date(NOW), upstream: null, version: null }]);
});

test('an Application on another System cannot supply a Service version', async () => {
  await using h = await startHub();
  expect(
    (
      await push(
        h.hub,
        { ...report('server-1', [NOW]), records: records() },
        { token: 'server-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await push(
        h.hub,
        {
          ...report('laptop-1', [NOW]),
          records: { records: [{ kind: 'service', name: 'web', record: SERVICE }], unreadable: [] },
        },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT version, upstream FROM service_versions WHERE system = 'laptop-1'`,
  ).toEqual([{ upstream: null, version: null }]);
});

test('Reports store the first installed version, ignore repeats, and keep Application changes', async () => {
  await using h = await startHub();
  const body = { ...report('laptop-1', [NOW]), records: records() };
  expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
  expect(await h.db.sql<Record<string, unknown>[]>`SELECT * FROM service_versions`).toEqual([
    {
      first_seen_at: new Date(NOW),
      service: 'web',
      system: 'laptop-1',
      upstream: 'apt:nginx',
      version: '1.26',
    },
  ]);

  h.clock.now += 1000;
  expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT count(*)::int AS n FROM service_versions`,
  ).toEqual([{ n: 1 }]);

  h.clock.now += 1000;
  expect(
    (
      await push(
        h.hub,
        { ...body, records: records({ ...APPLICATION, version: '1.27' }) },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT version, upstream, first_seen_at FROM service_versions ORDER BY first_seen_at`,
  ).toEqual([
    { first_seen_at: new Date(NOW), upstream: 'apt:nginx', version: '1.26' },
    { first_seen_at: new Date(NOW + 2000), upstream: 'apt:nginx', version: '1.27' },
  ]);
});

const aptCensus = (observedAt: number, installed: boolean) => ({
  managers: [
    {
      installation: '/',
      ...(installed
        ? {
            installed: {
              names: ['nginx:amd64'],
              observedAt,
              versions: [{ name: 'nginx:amd64', version: '1.26-1ubuntu2' }],
            },
          }
        : {}),
      manager: 'apt' as const,
      observedAt,
      result: { kind: 'available' as const, metadataAt: observedAt, updates: [] },
    },
  ],
  reboot: { kind: 'available' as const, observedAt, required: false },
});

test('a gap in the package census keeps the installed version rather than recording two installs', async () => {
  await using h = await startHub();
  const send = async (at: number, installed: boolean) => {
    h.clock.now = at;
    const body = {
      ...report('laptop-1', [at]),
      records: records(),
      updates: aptCensus(at, installed),
    };
    expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
  };
  await send(NOW, true);
  await send(NOW + 60_000, false);
  await send(NOW + 120_000, true);
  expect(await h.db.sql<Record<string, unknown>[]>`SELECT version FROM service_versions`).toEqual([
    { version: '1.26-1ubuntu2' },
  ]);
});

test('a Hub clock that steps back still puts the newest version last', async () => {
  await using h = await startHub();
  const send = async (at: number, version: string) => {
    h.clock.now = at;
    const body = {
      ...report('laptop-1', [NOW]),
      records: records({ ...APPLICATION, source: 'github:nginx/nginx', version }),
    };
    expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
  };
  await send(NOW + 10_000, '1.26');
  await send(NOW + 5000, '1.27');
  await send(NOW + 6000, '1.27');
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT version FROM service_versions ORDER BY first_seen_at`,
  ).toEqual([{ version: '1.26' }, { version: '1.27' }]);
});
