import { expect, test } from 'bun:test';

import { diskForecast, forecastWords } from './disk-forecast.ts';

const GIB = 1024 ** 3;
const BANDS = { alert: 90, note: 70, warning: 80 };
const disk = (usedGiB: number) => ({ mount: '/', totalBytes: 100 * GIB, usedBytes: usedGiB * GIB });
const growing = (gibPerDay: number) => ({ bytesPerDay: gibPerDay * GIB });

test('names the next band above the use and the days to reach it at the growth rate', () => {
  const forecast = diskForecast({ bands: BANDS, disk: disk(74), growth: growing(2) });
  expect(forecast).toEqual({ bytesPerDay: 2 * GIB, days: 3, kind: 'growing', percent: 80 });
});

test('names the alert band, then full, as use passes each', () => {
  expect(diskForecast({ bands: BANDS, disk: disk(85), growth: growing(1) })).toMatchObject({
    days: 5,
    percent: 90,
  });
  expect(diskForecast({ bands: BANDS, disk: disk(95), growth: growing(1) })).toMatchObject({
    days: 5,
    percent: 100,
  });
});

test('names only full while the Hub has stored no bands', () => {
  expect(diskForecast({ bands: undefined, disk: disk(10), growth: growing(1) })).toMatchObject({
    days: 90,
    percent: 100,
  });
});

test('gives no forecast for flat or shrinking growth', () => {
  expect(diskForecast({ bands: BANDS, disk: disk(50), growth: growing(0) })).toEqual({
    kind: 'none',
    reason: 'not-growing',
  });
  expect(diskForecast({ bands: BANDS, disk: disk(50), growth: growing(-1) })).toEqual({
    kind: 'none',
    reason: 'not-growing',
  });
});

test('gives no forecast without a trend, which needs a day of readings', () => {
  expect(diskForecast({ bands: BANDS, disk: disk(50), growth: undefined })).toEqual({
    kind: 'none',
    reason: 'few-readings',
  });
});

test('says growth and the next band in words, and why there is no forecast', () => {
  const growth = diskForecast({ bands: BANDS, disk: disk(74), growth: growing(2) });
  expect(forecastWords(growth)).toBe('+2 GiB/day · 80% in about 3 days');
  const full = diskForecast({ bands: undefined, disk: disk(10), growth: growing(0.1) });
  expect(forecastWords(full)).toBe('+0.1 GiB/day · full in about 900 days');
  expect(forecastWords(diskForecast({ bands: BANDS, disk: disk(74), growth: growing(80) }))).toBe(
    '+80 GiB/day · 80% in under a day',
  );
  expect(forecastWords({ kind: 'none', reason: 'not-growing' })).toBe(
    'Not growing over the last 7 days, so no forecast.',
  );
  expect(forecastWords({ kind: 'none', reason: 'few-readings' })).toBe(
    'Under a day of readings, so no forecast.',
  );
});
