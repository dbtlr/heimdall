import { Link } from '@tanstack/react-router';

import { nowLine } from '../lib/lane.ts';
import type { Attention } from '../server/attention-types.ts';
import type { Lane } from '../server/fleet-overview-types.ts';
import { AttentionStatus } from './attention-status.tsx';
import { PhraseText } from './date-time.tsx';

export function FleetSystems({
  lanes,
  attention,
  now,
}: {
  lanes: readonly Lane[];
  attention: readonly Attention[];
  now: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {lanes.map((lane) => (
        <Link
          className="min-w-0 rounded-xl border bg-card p-4 hover:border-muted-foreground"
          key={lane.name}
          params={{ name: lane.name }}
          to="/systems/$name"
        >
          <h3 className="text-xl font-semibold break-all">{lane.name}</h3>
          <p className="text-base">
            <AttentionStatus
              items={attention.filter((item) => item.system === lane.name)}
              status={lane.status}
            />
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            <PhraseText phrase={nowLine(lane, now)} />
          </p>
        </Link>
      ))}
    </div>
  );
}
