import { formatGiB } from '../lib/detail.ts';
import { diskUsage, fullestDisk } from '../lib/facts.ts';
import { formatSpan } from '../lib/time.ts';
import type { SystemDetail } from '../server/system-detail-types.ts';
import { DateTime } from './date-time.tsx';

// Samples use each System's clock, so date readings without inferring freshness.
export function SystemGlance({
  detail: { latest, now },
}: {
  detail: Pick<SystemDetail, 'latest' | 'now'>;
}) {
  if (latest === undefined) {
    return <p className="py-4 text-muted-foreground">No Vitals sample has arrived.</p>;
  }
  const disk = fullestDisk(latest.disks);
  const facts = [
    { label: 'CPU', value: `${String(Math.round(latest.cpuBusyPercent))}%` },
    {
      label: `of ${formatGiB(latest.memoryTotalBytes)} GiB memory`,
      value: formatGiB(latest.memoryUsedBytes),
    },
    {
      label: disk === undefined ? 'No disk sample' : `disk ${disk.mount}`,
      value: disk === undefined ? '—' : `${String(diskUsage(disk).percent)}%`,
    },
    { label: 'up', value: formatSpan(latest.uptimeSeconds * 1000) },
  ];
  return (
    <section aria-label="Last reported Vitals" className="my-4">
      <h2 className="mb-2 text-lg font-semibold">Last reported</h2>
      <p className="mb-2 text-sm text-muted-foreground">
        Sample time <DateTime at={latest.t} format="when" now={now} />.
      </p>
      <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {facts.map(({ label, value }) => (
          <div className="rounded-xl bg-card px-3 py-2.5" key={label}>
            <dd className="text-2xl leading-tight font-semibold">{value}</dd>
            <dt className="text-sm text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}
