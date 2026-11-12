import type { Disk } from '../server/system-detail-types.ts';
import { growthWords, isGrowing, reachWords } from './disk-growth.ts';
import type { DiskGrowth } from './disk-growth.ts';

// The used percents at which the Hub raises a Low disk note, warning, and alert.
export type DiskBands = { alert: number; note: number; warning: number };

// Where a mount is heading: how fast it grows and the next percent it reaches,
// 100 for full; or why no forecast can be made.
export type DiskForecast =
  | { bytesPerDay: number; days: number; kind: 'growing'; percent: number }
  | { kind: 'none'; reason: 'few-readings' | 'not-growing' };

// The next band above the mount's use, else full, and the days to reach it at
// the fitted growth: 0 for a mount already full. `growth` is undefined with
// under a day of readings; growth under a MiB a day is not growing.
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
  if (!isGrowing(growth) || disk.totalBytes <= 0) {
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

// A forecast as the Disks card says it, in the Condition page's words for
// growth and time: "+2.1 GiB a day · 80% in about 3 days".
export const forecastWords = (forecast: DiskForecast): string => {
  if (forecast.kind === 'none') {
    return forecast.reason === 'few-readings'
      ? 'Under a day of readings, so no forecast.'
      : 'Not growing over the last 7 days, so no forecast.';
  }
  const target = forecast.percent >= 100 ? 'full' : `${String(forecast.percent)}%`;
  return `${growthWords(forecast.bytesPerDay)} · ${target} ${reachWords(forecast.days)}`;
};
