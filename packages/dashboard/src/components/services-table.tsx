import { Link } from '@tanstack/react-router';

import { whenAt } from '../lib/phrase.ts';
import type { ServiceStatus, ServiceSummary } from '../lib/services.ts';
import { formatSpanShort } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { PhraseText } from './date-time.tsx';

const DOT: Record<ServiceStatus, string> = {
  down: 'bg-status-critical',
  restarted: 'bg-primary',
  unknown: 'border-[1.5px] border-muted-foreground',
  up: 'bg-status-good',
};

export function ServicesTable({ now, rows }: { now: number; rows: readonly ServiceSummary[] }) {
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <th className="w-1/2 px-3 py-3 font-medium" scope="col">
            Service
          </th>
          <th className="w-1/4 px-3 py-3 font-medium" scope="col">
            System
          </th>
          <th className="w-1/4 px-3 py-3 font-medium" scope="col">
            Version
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            className="relative border-b border-border/60 hover:bg-card focus-within:bg-card"
            key={`${row.system}/${row.name}`}
          >
            <td className="px-3 py-4 align-top">
              <Link
                className="flex items-baseline gap-2 font-medium after:absolute after:inset-0"
                params={{ name: row.system, service: row.name }}
                to="/systems/$name/services/$service"
              >
                <span
                  aria-hidden="true"
                  className={cn('size-2 shrink-0 self-center rounded-full', DOT[row.status])}
                />
                <span className="min-w-0 wrap-anywhere">
                  {row.name}
                  <span className="sr-only"> ({row.status})</span>
                </span>
              </Link>
              {row.status === 'down' && row.downSince !== undefined && (
                <p className="mt-0.5 pl-4 text-sm text-muted-foreground">
                  Down {formatSpanShort(now - row.downSince)}
                </p>
              )}
              {row.status === 'restarted' && row.latestStopAt !== undefined && (
                <p className="mt-0.5 pl-4 text-sm text-muted-foreground">
                  <PhraseText phrase={['Restarted ', whenAt(row.latestStopAt, now)]} />
                </p>
              )}
            </td>
            <td className="px-3 py-4 align-top text-muted-foreground wrap-anywhere">
              {row.system}
            </td>
            <td className="px-3 py-4 align-top wrap-anywhere">
              {row.version ?? <span className="text-muted-foreground">unknown</span>}
              {row.update !== undefined && (
                <span className="block text-sm text-muted-foreground">→ {row.update}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
