import { diskUsage, fullestDisk } from '../lib/facts.ts';
import type { Lane } from '../server/fleet-overview-types.ts';
import { DateTime } from './date-time.tsx';

export function FleetSystemVitals({ latest, now }: { latest: Lane['latest']; now: number }) {
  if (latest === undefined) {
    return <p className="my-3 text-sm text-muted-foreground">No Vitals sample has arrived.</p>;
  }
  const disk = fullestDisk(latest.disks);
  const facts = [
    { label: 'CPU', value: `${String(Math.round(latest.cpuBusyPercent))}%` },
    {
      label: latest.memoryUsedPercent === undefined ? 'memory unavailable' : 'memory',
      value:
        latest.memoryUsedPercent === undefined
          ? '—'
          : `${String(Math.round(latest.memoryUsedPercent))}%`,
    },
    {
      label: disk === undefined ? 'disk unavailable' : `disk ${disk.mount}`,
      value: disk === undefined ? '—' : `${String(diskUsage(disk).percent)}%`,
    },
  ];
  return (
    <div className="my-3">
      <p className="mb-2 text-sm text-muted-foreground">
        Last reported · sample time <DateTime at={latest.t} format="when" now={now} />
      </p>
      <dl className="grid grid-cols-3 gap-3">
        {facts.map(({ label, value }) => (
          <div className="min-w-0" key={label}>
            <dd className="text-2xl font-semibold">{value}</dd>
            <dt className="text-sm wrap-anywhere text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}
