import { expect, test } from 'bun:test';

import { ReportSchema } from './report.ts';
import type { Report } from './report.ts';
import { sample } from './testing.ts';
import type { UpdatesSection } from './updates-section.ts';
import {
  parseUpdateSubject,
  updateSourceSubject,
  updateSubject,
  UpdatesSectionSchema,
} from './updates-section.ts';

test('v1 Reports carry update coverage, unknown security and original observation times', () => {
  const updates = {
    managers: [
      {
        installation: '/usr/bin/apt',
        installed: { names: ['openssl:amd64'], observedAt: 1000 },
        manager: 'apt',
        observedAt: 1000,
        result: {
          kind: 'available',
          metadataAt: null,
          updates: [{ available: '1.1', installed: '1.0', name: 'openssl:amd64', security: null }],
        },
      },
    ],
    reboot: { kind: 'available', observedAt: 1000, required: true },
  } satisfies UpdatesSection;
  const report = {
    collector: { arch: 'arm64', platform: 'linux', version: '1' },
    samples: [sample(2000)],
    schemaVersion: 1,
    sentAt: 3000,
    system: 'test',
    updates,
  } satisfies Report;
  expect(ReportSchema.parse(report)).toEqual(report);
  expect(ReportSchema.parse({ ...report, updates: undefined }).updates).toBeUndefined();
});

test('update evidence rejects duplicate identities and oversized success without truncation', () => {
  const manager = {
    installation: '/mock/apt',
    manager: 'apt',
    observedAt: 1000,
    result: { kind: 'available', metadataAt: 1000, updates: [] },
  } satisfies UpdatesSection['managers'][number];
  const reboot = {
    kind: 'unavailable',
    observedAt: 1000,
    reason: 'unsupported',
  } satisfies UpdatesSection['reboot'];
  expect(UpdatesSectionSchema.safeParse({ managers: [manager, manager], reboot }).success).toBe(
    false,
  );
  expect(
    UpdatesSectionSchema.safeParse({
      managers: [{ ...manager, installed: { names: ['a', 'a'], observedAt: 1000 } }],
      reboot,
    }).success,
  ).toBe(false);
  const update = {
    available: '2'.repeat(512),
    installed: '1'.repeat(512),
    name: 'p',
    security: null,
  };
  const updates = Array.from({ length: 1100 }, (_, index) => ({
    ...update,
    name: `package-${String(index)}`,
  }));
  expect(
    UpdatesSectionSchema.safeParse({
      managers: [{ ...manager, result: { ...manager.result, updates } }],
      reboot,
    }).success,
  ).toBe(false);
});

test('confirmed installed versions name distinct members of the complete local census', () => {
  const manager = {
    installation: '/mock/apt',
    installed: {
      names: ['pkg:amd64'],
      observedAt: 1000,
      versions: [{ name: 'pkg:amd64', version: '2.0' }],
    },
    manager: 'apt',
    observedAt: 1000,
    result: { kind: 'unavailable', reason: 'metadata unavailable' },
  } satisfies UpdatesSection['managers'][number];
  const section = {
    managers: [manager],
    reboot: { kind: 'unavailable', observedAt: 1000, reason: 'unsupported' },
  } satisfies UpdatesSection;
  expect(UpdatesSectionSchema.parse(section)).toEqual(section);
  expect(
    UpdatesSectionSchema.safeParse({
      ...section,
      managers: [
        {
          ...manager,
          installed: {
            ...manager.installed,
            names: [],
          },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    UpdatesSectionSchema.safeParse({
      ...section,
      managers: [
        {
          ...manager,
          installed: {
            ...manager.installed,
            versions: [...manager.installed.versions, ...manager.installed.versions],
          },
        },
      ],
    }).success,
  ).toBe(false);
});

test('a package source subject names the manager and installation, and package subjects extend it', () => {
  const source = { installation: '/opt/homebrew', manager: 'homebrew' } as const;
  expect(updateSourceSubject(source)).toBe('["homebrew","/opt/homebrew"]');
  expect(parseUpdateSubject(updateSourceSubject(source))).toEqual({
    installation: '/opt/homebrew',
    manager: 'homebrew',
    name: undefined,
  });
  expect(parseUpdateSubject(updateSubject(source, 'wget'))).toEqual({
    installation: '/opt/homebrew',
    manager: 'homebrew',
    name: 'wget',
  });
  expect(parseUpdateSubject('["homebrew"]')).toBeUndefined();
  expect(parseUpdateSubject('["homebrew",1]')).toBeUndefined();
  expect(parseUpdateSubject('not json')).toBeUndefined();
});
