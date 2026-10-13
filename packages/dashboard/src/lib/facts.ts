import type { Disk } from '../server/system-detail-types.ts';

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

// A mount is nearly full below this fraction free: the Hub raises its low disk
// Condition at the same point (`lowDiskBelow` in the Hub's system-conditions.ts).
const NEARLY_FULL_BELOW_FREE = 0.1;

// A size to one decimal, without a trailing zero, or whole from 100 up.
const size = (value: number) =>
  value >= 100 ? value.toFixed(0) : String(Number(value.toFixed(1)));

// A mount's use for the facts card: "412 of 931 GiB" in the unit of its size,
// the percent used, held at 100 for a mount used past its size, and whether it
// is nearly full. A mount with no size has nothing to judge.
export const diskUsage = ({ totalBytes, usedBytes }: Disk) => {
  const [unit, unitBytes] = totalBytes >= TIB ? (['TiB', TIB] as const) : (['GiB', GIB] as const);
  return {
    nearlyFull: totalBytes > 0 && (totalBytes - usedBytes) / totalBytes < NEARLY_FULL_BELOW_FREE,
    percent: totalBytes === 0 ? 0 : Math.min(100, Math.round((usedBytes / totalBytes) * 100)),
    text: `${size(usedBytes / unitBytes)} of ${size(totalBytes / unitBytes)} ${unit}`,
  };
};

// A load average to two decimals.
export const formatLoad = (load: number): string => load.toFixed(2);
