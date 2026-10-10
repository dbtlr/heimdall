import { expect, test } from 'bun:test';

import { systemTimeZone } from './time-zone.ts';

test.each(['Europe/Paris', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5'])(
  'the runtime time zone %s is reported as it is',
  (zone) => {
    expect(systemTimeZone(() => zone)).toBe(zone);
  },
);

test.each(['', '1/2', 'Not A Zone', `A${'b'.repeat(64)}`, '+05:00'])(
  'a time zone the Hub would reject (%p) is left out of the Report',
  (zone) => {
    expect(systemTimeZone(() => zone)).toBeUndefined();
  },
);
