import { expect, test } from 'bun:test';

import type { ApplicationRecord, ServiceRecord, UpdateManager } from '@heimdall/schema';

import { deriveServiceVersion, parseDockerImage } from './service-versions.ts';
import { NOW } from './testing/hub.ts';

const APPLICATION: ApplicationRecord = {
  name: 'nginx',
  source: 'github:nginx/nginx',
  version: '1.26',
};
const SERVICE: ServiceRecord = { application: 'nginx', name: 'web', supervisor: 'none' };
const DOCKER: ServiceRecord = { container: 'web', name: 'web', supervisor: 'docker' };
const CENSUS = {
  observation: {
    installation: '/',
    installed: {
      names: ['nginx:arm64', 'nginx:amd64'],
      observedAt: NOW,
      versions: [
        { name: 'nginx:arm64', version: '1.28' },
        { name: 'nginx:amd64', version: '1.29' },
      ],
    },
    manager: 'apt',
    observedAt: NOW,
    result: { kind: 'unavailable', reason: 'Metadata unavailable.' },
  } satisfies UpdateManager,
  withdrawn: false,
};

test.each([
  ['nginx', null, 'oci:docker.io/library/nginx'],
  ['nginx:1.27', '1.27', 'oci:docker.io/library/nginx'],
  ['docker.io/library/nginx:1.27', '1.27', 'oci:docker.io/library/nginx'],
  ['index.docker.io/nginx:1.27', '1.27', 'oci:docker.io/library/nginx'],
  ['team/app:2', '2', 'oci:docker.io/team/app'],
  ['ghcr.io/team/app:2', '2', 'oci:ghcr.io/team/app'],
  ['localhost/app', null, 'oci:localhost/app'],
  ['localhost:5000/app:1', '1', 'oci:localhost:5000/app'],
  ['localhost:5000/app', null, 'oci:localhost:5000/app'],
  ['registry:5000/app:1', '1', 'oci:registry:5000/app'],
  ['nginx@sha256:abc', null, 'oci:docker.io/library/nginx'],
  ['nginx:1.27@sha256:abc', '1.27', 'oci:docker.io/library/nginx'],
  ['sha256:abc', null, null],
  ['a'.repeat(64), null, null],
])('Docker image %s has version %s and upstream %s', (image, version, upstream) => {
  expect(parseDockerImage(image)).toEqual({ upstream, version });
});

test('a Docker Service takes the image tag and its normalized upstream', () => {
  expect(
    deriveServiceVersion({ applications: [], image: 'nginx:1.27', now: NOW, service: DOCKER }),
  ).toEqual({ censusLapsed: false, upstream: 'oci:docker.io/library/nginx', version: '1.27' });
});

test('a Docker Service naming an Application keeps its image tag and takes that upstream', () => {
  expect(
    deriveServiceVersion({
      applications: [APPLICATION],
      image: 'nginx:1.27',
      now: NOW,
      service: { ...DOCKER, application: 'nginx' },
    }),
  ).toEqual({ censusLapsed: false, upstream: 'github:nginx/nginx', version: '1.27' });
});

test('a missing Application leaves a Docker image tag known but its upstream unknown', () => {
  expect(
    deriveServiceVersion({
      applications: [],
      image: 'nginx:1.27',
      now: NOW,
      service: { ...DOCKER, application: 'missing' },
    }),
  ).toEqual({ censusLapsed: false, upstream: null, version: '1.27' });
});

test('a Docker Service without an image never falls back to the recorded version', () => {
  expect(
    deriveServiceVersion({
      applications: [APPLICATION],
      now: NOW,
      service: { ...DOCKER, application: 'nginx' },
    }),
  ).toEqual({ censusLapsed: false, upstream: 'github:nginx/nginx', version: null });
});

test('a Docker Service naming an Application without an upstream never uses its image upstream', () => {
  expect(
    deriveServiceVersion({
      applications: [{ name: 'nginx', version: '1.26' }],
      image: 'nginx:1.27',
      now: NOW,
      service: { ...DOCKER, application: 'nginx' },
    }),
  ).toEqual({ censusLapsed: false, upstream: null, version: '1.27' });
});

test.each(['github:nginx/nginx', 'npm:nginx', 'custom:anything', undefined])(
  'a non-Docker Service takes its Application version and verbatim upstream %s',
  (upstream) => {
    expect(
      deriveServiceVersion({
        applications: [{ ...APPLICATION, source: upstream }],
        image: 'ignored:9',
        now: NOW,
        service: SERVICE,
      }),
    ).toEqual({ censusLapsed: false, upstream: upstream ?? null, version: '1.26' });
  },
);

test('APT matches any architecture and takes the first confirmed version in census order', () => {
  expect(
    deriveServiceVersion({
      applications: [{ ...APPLICATION, source: 'apt:nginx' }],
      censuses: [CENSUS],
      now: NOW,
      service: SERVICE,
    }),
  ).toEqual({ censusLapsed: false, upstream: 'apt:nginx', version: '1.28' });
});

test('census freshness uses the installed observation time, including the freshness boundary', () => {
  expect(
    deriveServiceVersion({
      applications: [{ ...APPLICATION, source: 'apt:nginx' }],
      censuses: [
        {
          ...CENSUS,
          observation: {
            ...CENSUS.observation,
            installed: { ...CENSUS.observation.installed, observedAt: NOW - 86400000 },
            observedAt: NOW - 2 * 86400000,
          },
        },
      ],
      now: NOW,
      service: SERVICE,
    }),
  ).toEqual({ censusLapsed: false, upstream: 'apt:nginx', version: '1.28' });
});

test.each(['formula:nginx', 'cask:nginx'])(
  'Homebrew matches %s from any installation and takes the first matching census',
  (name) => {
    const observation: UpdateManager = {
      ...CENSUS.observation,
      installation: '/opt/other-brew',
      installed: { names: [name], observedAt: NOW, versions: [{ name, version: '1.30' }] },
      manager: 'homebrew',
    };
    expect(
      deriveServiceVersion({
        applications: [{ ...APPLICATION, source: 'brew:nginx' }],
        censuses: [
          CENSUS,
          { observation, withdrawn: false },
          {
            observation: {
              ...observation,
              installation: '/opt/another-brew',
              installed: { names: [name], observedAt: NOW, versions: [{ name, version: '1.31' }] },
            },
            withdrawn: false,
          },
        ],
        now: NOW,
        service: SERVICE,
      }),
    ).toEqual({ censusLapsed: false, upstream: 'brew:nginx', version: '1.30' });
  },
);

test('a package census never replaces a Docker image tag', () => {
  expect(
    deriveServiceVersion({
      applications: [{ ...APPLICATION, source: 'apt:nginx' }],
      censuses: [CENSUS],
      image: 'nginx:1.27',
      now: NOW,
      service: { ...DOCKER, application: 'nginx' },
    }),
  ).toEqual({ censusLapsed: false, upstream: 'apt:nginx', version: '1.27' });
});

test.each([
  ['withdrawn', { ...CENSUS, withdrawn: true }],
  [
    'stale',
    {
      ...CENSUS,
      observation: {
        ...CENSUS.observation,
        installed: { ...CENSUS.observation.installed, observedAt: NOW - 86400001 },
      },
    },
  ],
  [
    'future-dated',
    {
      ...CENSUS,
      observation: {
        ...CENSUS.observation,
        installed: { ...CENSUS.observation.installed, observedAt: NOW + 86400000 },
      },
    },
  ],
  [
    'names without versions',
    {
      ...CENSUS,
      observation: {
        ...CENSUS.observation,
        installed: { names: ['nginx:amd64'], observedAt: NOW },
      },
    },
  ],
  [
    'missing installed census',
    { ...CENSUS, observation: { ...CENSUS.observation, installed: undefined } },
  ],
  [
    'another package',
    {
      ...CENSUS,
      observation: {
        ...CENSUS.observation,
        installed: {
          names: ['nginx-extra:amd64'],
          observedAt: NOW,
          versions: [{ name: 'nginx-extra:amd64', version: '9' }],
        },
      },
    },
  ],
] satisfies [string, { observation: UpdateManager; withdrawn: boolean }][])(
  'a %s census leaves the Application version as recorded',
  (kind, census) => {
    expect(
      deriveServiceVersion({
        applications: [{ ...APPLICATION, source: 'apt:nginx' }],
        censuses: [census],
        now: NOW,
        service: SERVICE,
      }),
    ).toEqual({
      // A fresh census covers the package even when it lacks its version.
      censusLapsed: kind !== 'another package' && kind !== 'names without versions',
      upstream: 'apt:nginx',
      version: '1.26',
    });
  },
);

test.each([SERVICE, { name: 'web', supervisor: 'none' } satisfies ServiceRecord])(
  'a Service without a recorded Application has unknown version and upstream: %j',
  (service) => {
    expect(deriveServiceVersion({ applications: [], now: NOW, service })).toEqual({
      censusLapsed: false,
      upstream: null,
      version: null,
    });
  },
);

test('a short image ID names no repository', () => {
  expect(parseDockerImage('4f2a1b3c9d8e')).toEqual({ upstream: null, version: null });
});
