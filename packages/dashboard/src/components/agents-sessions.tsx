import { Link } from '@tanstack/react-router';

import { harnessColor, harnessName } from '../lib/lane.ts';
import { formatCost } from '../lib/time.ts';
import type { AgentsSession } from '../server/agents-overview-types.ts';
import { DateTime } from './date-time.tsx';

// `picked` names the breakdown row the list is filtered to, if any.
export function AgentsSessions({
  now,
  picked,
  sessions,
}: {
  now: number;
  picked?: string | undefined;
  sessions: AgentsSession[];
}) {
  return (
    <section aria-labelledby="agents-sessions-heading">
      <h2 className="mb-3 text-base font-semibold" id="agents-sessions-heading">
        Most expensive first
      </h2>
      {picked !== undefined && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Sessions in</span>
          <Link
            aria-label={`Show all Sessions, not only those in ${picked}`}
            className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-chart-1 bg-accent px-3 break-all"
            resetScroll={false}
            search={(previous) => ({ ...previous, pick: undefined })}
            to="."
          >
            {picked}
            <svg aria-hidden="true" height="9" viewBox="0 0 10 10" width="9">
              <path d="M1 1l8 8M9 1l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </Link>
        </p>
      )}
      {sessions.some((session) => session.unpricedRequests > 0) && (
        <p className="mb-3 text-sm text-muted-foreground">
          Unpriced requests may change this order.
        </p>
      )}
      {sessions.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-5 text-muted-foreground">
          No requests in this period.
        </p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((session) => (
            <li
              key={JSON.stringify([
                session.system,
                session.harness,
                session.source,
                session.sessionId,
              ])}
            >
              <Link
                className="flex min-h-20 gap-3 rounded-xl border bg-card px-3 py-3 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-4"
                params={{
                  harness: session.harness,
                  name: session.system,
                  sessionId: session.sessionId,
                  source: session.source,
                }}
                to="/systems/$name/sessions/$harness/$source/$sessionId"
              >
                <span
                  aria-hidden="true"
                  className="w-1.5 shrink-0 rounded-full"
                  style={{ background: harnessColor(session.harness) }}
                />
                <div className="min-w-0 flex-1 break-words">
                  <p className="text-base leading-snug font-semibold break-words sm:text-lg">
                    {session.project ??
                      `${harnessName(session.harness)} Session ${session.sessionId.slice(0, 8)}`}
                    {session.branch !== undefined && (
                      <span className="font-normal text-muted-foreground"> {session.branch}</span>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {session.system} · {harnessName(session.harness)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {session.activeRecently ? (
                      <span
                        className="text-[#9fc5b0]"
                        title="A request was observed in the last 60 seconds"
                      >
                        Active recently
                      </span>
                    ) : (
                      <>
                        Last request <DateTime at={session.lastRequestAt} format="when" now={now} />
                      </>
                    )}
                  </p>
                </div>
                <div className="max-w-[40%] shrink-0 self-center text-right">
                  <p className="text-base font-semibold tabular-nums sm:text-xl">
                    {session.unpricedRequests > 0 && (
                      <span className="block text-xs font-normal text-[#c9b6ff]">At least </span>
                    )}
                    {formatCost(session.pricedCostUsd)}
                  </p>
                  {session.unpricedRequests > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {session.unpricedRequests} unpriced{' '}
                      {session.unpricedRequests === 1 ? 'request' : 'requests'}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
