import { formatGiB } from '../lib/detail.ts';
import { diskUsage } from '../lib/facts.ts';
import { formatSpan } from '../lib/time.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { SystemDetail } from '../server/system-detail-types.ts';
import { DateTime } from './date-time.tsx';

// A stale sample remains useful, but its readings never claim to be current.
export function SystemGlance({
  detail: { latest, now },
}: {
  detail: Pick<SystemDetail, 'latest' | 'now'>;
}) {
  if (latest === undefined) {
    return <p className="py-4 text-muted-foreground">No Vitals sample has arrived.</p>;
  }
  const stale = now - latest.t > QUIET_AFTER_MS;
  const disk = latest.disks.reduce<(typeof latest.disks)[number] | undefined>(
    (highest, candidate) =>
      highest === undefined || diskUsage(candidate).percent > diskUsage(highest).percent
        ? candidate
        : highest,
    undefined,
  );
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
    <section aria-label={stale ? 'Last reported Vitals' : 'Right now'} className="my-4">
      <h2 className="mb-2 text-lg font-semibold">{stale ? 'Last reported' : 'Right now'}</h2>
      {stale && (
        <p className="mb-2 text-sm text-muted-foreground">
          Sample from <DateTime at={latest.t} format="when" now={now} />.
        </p>
      )}
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
