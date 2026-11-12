import type { Disk } from '../server/system-detail-types.ts';
import type { DiskGrowth } from './disk-growth.ts';

// The used percents at which the Hub raises a Low disk note, warning, and alert.
export type DiskBands = { alert: number; note: number; warning: number };

// Where a mount is heading: how fast it grows and the next percent it reaches,
// 100 for full; or why no forecast can be made.
export type DiskForecast =
  | { bytesPerDay: number; days: number; kind: 'growing'; percent: number }
  | { kind: 'none'; reason: 'few-readings' | 'not-growing' };

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

// The next band above the mount's use, else full, and the days to reach it at
// the fitted growth. `growth` is undefined with under a day of readings.
export const diskForecast = ({
  bands,
  disk,
  growth,
}: {
  bands: DiskBands | undefined;
  disk: Disk;
  growth: Pick<DiskGrowth, 'bytesPerDay'> | undefined;
}): DiskForecast => {
  if (growth === undefined) {
    return { kind: 'none', reason: 'few-readings' };
  }
  if (growth.bytesPerDay <= 0 || disk.totalBytes <= 0) {
    return { kind: 'none', reason: 'not-growing' };
  }
  const used = (disk.usedBytes / disk.totalBytes) * 100;
  const percent =
    bands === undefined
      ? 100
      : ([bands.note, bands.warning, bands.alert].find((band) => band > used && band < 100) ?? 100);
  const bytesToGo = Math.max(0, (percent / 100) * disk.totalBytes - disk.usedBytes);
  return {
    bytesPerDay: growth.bytesPerDay,
    days: bytesToGo / growth.bytesPerDay,
    kind: 'growing',
    percent,
  };
};

const rate = (bytesPerDay: number) => {
  let [unit, bytes] = ['MiB', MIB] as [string, number];
  if (bytesPerDay >= TIB) {
    [unit, bytes] = ['TiB', TIB];
  } else if (bytesPerDay >= GIB / 10) {
    [unit, bytes] = ['GiB', GIB];
  }
  const value = bytesPerDay / bytes;
  return `+${String(Number(value >= 100 ? value.toFixed(0) : value.toFixed(1)))} ${unit}/day`;
};

const dayWords = (days: number) => {
  const whole = Math.round(days);
  return days < 1 ? 'under a day' : `about ${String(whole)} ${whole === 1 ? 'day' : 'days'}`;
};

// A forecast as the Disks card says it.
export const forecastWords = (forecast: DiskForecast): string => {
  if (forecast.kind === 'none') {
    return forecast.reason === 'few-readings'
      ? 'Under a day of readings, so no forecast.'
      : 'Not growing over the last 7 days, so no forecast.';
  }
  const target = forecast.percent >= 100 ? 'full' : `${String(forecast.percent)}%`;
  return `${rate(forecast.bytesPerDay)} · ${target} in ${dayWords(forecast.days)}`;
};
