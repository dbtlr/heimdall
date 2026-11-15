import { Link } from '@tanstack/react-router';

import { breakdownRows } from '../lib/agents-breakdown.ts';
import { isRunning } from '../lib/home-agents.ts';
import { harnessColor } from '../lib/lane.ts';
import { formatCost, formatDate, formatPast, formatSpan } from '../lib/time.ts';
import type { SessionsQuery } from '../server/agents-overview-types.ts';
import type { ProjectView } from '../server/project-view.ts';
import { AgentsChart } from './agents-chart.tsx';
import { rangeName } from './agents-headline.tsx';
import { AgentsSessions } from './agents-sessions.tsx';

// The dossier shares the Agents chart, breakdown calculations and Session
// table; its lanes describe request activity rather than process lifetimes.
export function ProjectDossier({ view, query }: { view: ProjectView; query: SessionsQuery }) {
  const { overview } = view;
  const { now, timeZone } = overview;
  const models = breakdownRows(overview, 'model');
  // Each day/hour occupies the same width as its cost bar, including DST days.
  const position = (at: number) => {
    const { buckets } = overview.chart;
    const index = buckets.findIndex((bucket) => at < bucket.end);
    if (index === -1) {
      return 100;
    }
    const bucket = buckets[index];
    if (bucket === undefined) {
      return 0;
    }
    return (
      ((index + Math.max(0, (at - bucket.start) / (bucket.end - bucket.start))) / buckets.length) *
      100
    );
  };
  const figures = [
    {
      label: 'List-price cost',
      note: `${rangeName(overview.range)} · ${overview.totals.unpricedRequests} unpriced requests`,
      value: `${overview.totals.unpricedRequests > 0 ? 'At least ' : ''}${formatCost(overview.totals.pricedCostUsd)}`,
    },
    {
      label: 'Active time',
      note: 'request activity in Session stretches',
      value: formatSpan(view.activeMs),
    },
    {
      label: 'Sessions',
      note: `${view.subagents} subagents · ${overview.totals.requests} requests`,
      value: String(overview.sessionCount),
    },
    {
      label: 'Harness process CPU',
      note:
        view.peakRssBytes === undefined
          ? 'No process memory readings'
          : `peak memory ${(view.peakRssBytes / 1024 ** 3).toFixed(1)} GiB, one process`,
      value: `${(view.cpuSeconds / 3600).toFixed(1)} CPU-h`,
    },
  ];
  return (
    <>
      <div className="text-sm text-muted-foreground">
        <Link to="/agents">Agents</Link> / Projects / {view.name}
        <p>
          Git repository on {view.systems.join(', ')} · first Session{' '}
          {formatDate(view.firstSessionAt, timeZone)} · last request{' '}
          {view.lastRequestAt === undefined
            ? 'none yet'
            : formatPast(view.lastRequestAt, now, timeZone)}{' '}
          · {overview.running.length} running
        </p>
      </div>
      <section aria-label="Project totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {figures.map((figure) => (
          <div className="card-surface rounded-xl border p-4" key={figure.label}>
            <h2 className="text-sm text-muted-foreground">{figure.label}</h2>
            <p className="my-1 text-2xl font-semibold tabular-nums">{figure.value}</p>
            <p className="text-xs text-muted-foreground">{figure.note}</p>
          </div>
        ))}
      </section>
      <section aria-label="When and where" className="space-y-3">
        <h2 className="text-base font-semibold">When and where</h2>
        <AgentsChart
          by="harness"
          dossier
          overview={overview}
          pick={undefined}
          belowPlot={
            <div className="space-y-3">
              {[...new Set(view.lanes.map((lane) => lane.system))].map((system) => (
                <div className="space-y-1" key={system}>
                  <Link className="truncate text-sm" params={{ name: system }} to="/systems/$name">
                    {system}
                  </Link>
                  <div className="relative h-6 rounded bg-muted/30">
                    {view.lanes
                      .filter((lane) => lane.system === system)
                      .map((lane) => (
                        <Link
                          aria-label={`${system} ${lane.sessionId}${isRunning(lane.end, now) ? ', running' : ''}`}
                          className={`absolute top-1 h-4 min-w-1 rounded ${isRunning(lane.end, now) ? 'ring-2 ring-foreground' : ''}`}
                          key={JSON.stringify([
                            lane.harness,
                            lane.source,
                            lane.sessionId,
                            lane.start,
                          ])}
                          params={{
                            harness: lane.harness,
                            name: system,
                            sessionId: lane.sessionId,
                            source: lane.source,
                          }}
                          style={{
                            background: harnessColor(lane.harness),
                            left: `${position(lane.start)}%`,
                            width: `${position(lane.end) - position(lane.start)}%`,
                          }}
                          title={`${lane.sessionId} · ${formatSpan(lane.end - lane.start)}`}
                          to="/systems/$name/sessions/$harness/$source/$sessionId"
                        />
                      ))}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {formatDate(overview.from, timeZone)} — {formatDate(now, timeZone)} · request
                activity; overlapping Sessions share a lane
              </p>
            </div>
          }
        />
      </section>
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card-surface rounded-xl border p-4">
          <h2 className="mb-3 font-semibold">Models</h2>
          {models.length === 0 ? (
            <p>No requests in this period.</p>
          ) : (
            <ul className="space-y-2">
              {models.map((row) => (
                <li className="flex justify-between gap-3 text-sm" key={row.key}>
                  <span className="break-all">{row.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {row.pricing === 'none'
                      ? 'No list price'
                      : `${row.pricing === 'at-least' ? 'At least ' : ''}${formatCost(row.pricedCostUsd)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card-surface rounded-xl border p-4">
          <h2 className="mb-3 font-semibold">
            Tools and skills{' '}
            <span className="text-xs font-normal text-muted-foreground">calls</span>
          </h2>
          <ul className="space-y-2">
            {view.tools.map((tool) => (
              <li className="flex justify-between gap-3 text-sm" key={JSON.stringify(tool)}>
                <span className="break-all">
                  {[tool.mcpServer, tool.name, tool.skill === null ? null : `skill · ${tool.skill}`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="tabular-nums">{tool.calls}</span>
              </li>
            ))}
          </ul>
          {view.tools.length === 0 && <p>No tool calls in this period.</p>}
          <p className="mt-3 text-xs text-muted-foreground">
            Names and counts only; no arguments or output.
          </p>
        </section>
        <section className="card-surface rounded-xl border p-4">
          <h2 className="mb-3 font-semibold">
            Branches <span className="text-xs font-normal text-muted-foreground">Sessions</span>
          </h2>
          <ul className="space-y-2">
            {view.branches.map((branch) => (
              <li className="flex justify-between gap-3 text-sm" key={branch.name}>
                <span className="break-all">{branch.name}</span>
                <span className="tabular-nums">{branch.sessions}</span>
              </li>
            ))}
          </ul>
          {view.branches.length === 0 && <p>No recorded branch in this period.</p>}
        </section>
      </div>
      <AgentsSessions
        by={query.by}
        dir={query.dir}
        now={now}
        pick={query.pick}
        rangeText={`in ${rangeName(overview.range)}`}
        sort={query.sort}
        table={overview.table}
        timeZone={timeZone}
      />
      <p className="text-xs text-muted-foreground">
        Token usage at API list prices, including subagents. Subscription charges may differ.
        Amounts include only this period. Process CPU sums measured rollup buckets; peak memory is
        the largest recorded process peak.
      </p>
    </>
  );
}
