import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { Disk } from '../server/system-detail-types.ts';
import { growthWords, isGrowing, reachWords, spanWords } from './disk-growth.ts';
import type { DiskGrowth } from './disk-growth.ts';

// The used percents at which the Hub raises a Low disk note, warning, and alert.
export type DiskBands = { alert: number; note: number; warning: number };

// Where a mount is heading: how fast it grows and the next percent it reaches,
// 100 for full; or why no forecast can be made.
export type DiskForecast =
  | { bytesPerDay: number; days: number; kind: 'growing'; percent: number }
  | { kind: 'none'; reason: 'few-readings' | 'not-growing' | 'unknown-size' | 'size-changed' };

// The next band above the mount's use, else full, and the days to reach it at
// the fitted growth: 0 for a mount already full. `growth` is undefined with
// under a day of readings; growth under a MiB a day is not growing.
export const diskForecast = ({
  bands,
  disk,
  growth,
  sizeChanged = false,
}: {
  bands: DiskBands | undefined;
  sizeChanged?: boolean;
  disk: Disk;
  growth: Pick<DiskGrowth, 'bytesPerDay'> | undefined;
}): DiskForecast => {
  if (disk.totalBytes <= 0) {
    return { kind: 'none', reason: 'unknown-size' };
  }
  if (growth === undefined) {
    return { kind: 'none', reason: sizeChanged ? 'size-changed' : 'few-readings' };
  }
  if (!isGrowing(growth)) {
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

// Whether the System's newest disk reading, taken at `at`, is no longer
// current at `now`; its facts are then dated to that reading, not to now.
export const isQuietReading = (at: number, now: number): boolean => now - at > QUIET_AFTER_MS;

// The fitted span as both pages word it: "over the last 3 days", or, once the
// System is quiet, "over the 3 days to the newest reading".
export const spanWindowWords = (spanMs: number, fromNewestReading: boolean): string =>
  fromNewestReading
    ? ` over the ${spanWords(spanMs)} to the newest reading`
    : ` over the last ${spanWords(spanMs)}`;

// When a growing mount is reached, counted from the newest reading once quiet.
export const countdownWords = (days: number, fromNewestReading: boolean): string =>
  `${reachWords(days)}${fromNewestReading && days > 0 ? ' from the newest reading' : ''}`;

// A forecast as the Disks card says it, in the Condition page's words for
// growth and time, with the actual fitted span when one is available.
export const forecastWords = (
  forecast: DiskForecast,
  fromNewestReading = false,
  spanMs?: number,
): string => {
  const window = spanMs === undefined ? '' : spanWindowWords(spanMs, fromNewestReading);
  if (forecast.kind === 'none') {
    if (forecast.reason === 'size-changed') {
      return 'Under a day of readings since the size changed, so no forecast.';
    }
    if (forecast.reason === 'unknown-size') {
      return 'Disk size is unknown or zero, so no forecast.';
    }
    if (forecast.reason === 'few-readings') {
      return 'Under a day of readings, so no forecast.';
    }
    return `Not growing${window}, so no forecast.`;
  }
  const target = forecast.percent >= 100 ? 'full' : `${String(forecast.percent)}%`;
  if (fromNewestReading && forecast.days <= 0) {
    return `${growthWords(forecast.bytesPerDay)}${window} · ${target} at the newest reading`;
  }
  return `${growthWords(forecast.bytesPerDay)}${window} · ${target} ${countdownWords(forecast.days, fromNewestReading)}`;
};
