import { Link } from '@tanstack/react-router';

import { whenAt } from '../lib/phrase.ts';
import type { ServiceStatus, ServiceSummary } from '../lib/services.ts';
import { formatSpanShort } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { PhraseText } from './date-time.tsx';

const DOT: Record<ServiceStatus, string> = {
  down: 'bg-status-critical',
  restarted: 'bg-status-warning',
  unknown: 'border-[1.5px] border-muted-foreground',
  up: 'bg-status-good',
};

export function ServicesTable({ now, rows }: { now: number; rows: readonly ServiceSummary[] }) {
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <th className="w-[40%] px-2 py-3 sm:w-1/2 sm:px-3 font-medium" scope="col">
            Service
          </th>
          <th className="w-[30%] px-2 py-3 sm:w-1/4 sm:px-3 font-medium" scope="col">
            System
          </th>
          <th className="w-[30%] px-2 py-3 sm:w-1/4 sm:px-3 font-medium" scope="col">
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
            <td className="px-2 py-4 align-top sm:px-3">
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
            <td
              className="overflow-hidden px-2 py-4 align-top text-ellipsis text-muted-foreground sm:px-3"
              title={row.system}
            >
              {row.system}
            </td>
            <td
              className="overflow-hidden px-2 py-4 align-top text-ellipsis whitespace-nowrap sm:px-3"
              title={row.version ?? 'unknown'}
            >
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
