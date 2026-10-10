import { expect, test } from 'bun:test';

import { systemTimeZone, zoneOfLocaltimeLink } from './time-zone.ts';

test.each([
  ['/usr/share/zoneinfo/Europe/Paris', 'Europe/Paris'],
  ['/usr/share/zoneinfo/America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['../usr/share/zoneinfo/Europe/Paris', 'Europe/Paris'],
  ['/etc/zoneinfo/Asia/Kolkata', 'Asia/Kolkata'],
  ['/nix/store/abc123-tzdata-2025b/share/zoneinfo/Europe/Berlin', 'Europe/Berlin'],
  ['/var/db/timezone/zoneinfo/America/New_York', 'America/New_York'],
  ['/var/db/timezone/tz/2025b.1.0/zoneinfo/Asia/Tokyo', 'Asia/Tokyo'],
  ['/usr/share/zoneinfo/posix/Europe/Paris', 'Europe/Paris'],
  ['/usr/share/zoneinfo/right/Europe/Paris', 'Europe/Paris'],
  ['/usr/share/zoneinfo/UTC', 'UTC'],
  ['/usr/share/zoneinfo/Etc/GMT+5', 'Etc/GMT+5'],
  ['/usr/share/zoneinfo/zoneinfo/Europe/Paris', 'Europe/Paris'],
])('the /etc/localtime target %s names the zone %s', (target, zone) => {
  expect(zoneOfLocaltimeLink(target)).toBe(zone);
});

test.each([
  '',
  '/usr/share/zoneinfo/',
  '/usr/share/zoneinfo/posix/',
  '/usr/share/zoneinfo/Not A Zone',
  '/usr/share/zoneinfo/1/2',
  `/usr/share/zoneinfo/A${'b'.repeat(64)}`,
  '/etc/localtime-backup',
  '/usr/share/lib/Europe/Paris',
  'Europe/Paris',
  'garbage',
])('the /etc/localtime target %p names no zone', (target) => {
  expect(zoneOfLocaltimeLink(target)).toBeUndefined();
});

test('the zone is read from the /etc/localtime link on every call, so a change is seen without a restart', () => {
  let target = '/usr/share/zoneinfo/Europe/Paris';
  const zone = () => systemTimeZone((path) => (path === '/etc/localtime' ? target : ''));

  expect(zone()).toBe('Europe/Paris');
  target = '/usr/share/zoneinfo/Asia/Kolkata';
  expect(zone()).toBe('Asia/Kolkata');
});

test('a missing or unreadable /etc/localtime leaves the zone out of the Report', () => {
  expect(
    systemTimeZone(() => {
      throw new Error('ENOENT');
    }),
  ).toBeUndefined();
});

test('the process TZ does not decide the zone', () => {
  const before = process.env.TZ;
  process.env.TZ = 'garbage';
  try {
    expect(systemTimeZone(() => '/usr/share/zoneinfo/Europe/Paris')).toBe('Europe/Paris');
  } finally {
    if (before === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = before;
    }
  }
});
