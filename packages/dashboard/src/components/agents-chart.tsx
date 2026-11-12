import { breakdownRows, NEUTRAL_COLOR } from '../lib/agents-breakdown.ts';
import { barStacks, costDomain, OTHERS_KEY } from '../lib/agents-chart.ts';
import type { BarStack } from '../lib/agents-chart.ts';
import { scaleTicks, yPercent } from '../lib/chart-scale.ts';
import type { Domain } from '../lib/chart-scale.ts';
import { formatClock, formatCost, formatDate } from '../lib/time.ts';
import type { AgentsBreakdown, AgentsOverview } from '../server/agents-overview-types.ts';
import { AgentsBreakdownSwitch, AgentsLegend, SWITCH_LABELS } from './agents-breakdown.tsx';
import { ScaledPlot } from './plot-scale.tsx';

const dollars = (value: number): string => `$${String(Number(value.toFixed(2)))}`;

// Roughly how many labels the time axis carries.
const AXIS_LABELS = 6;

const axisLabel = (overview: AgentsOverview, index: number): string | undefined => {
  const { buckets, unit } = overview.chart;
  const bucket = buckets[index];
  if (bucket === undefined) {
    return undefined;
  }
  if (unit === 'hour') {
    return index % 3 === 0 ? formatClock(bucket.start, overview.timeZone) : undefined;
  }
  if (index === buckets.length - 1) {
    return 'Today';
  }
  const step = Math.ceil(buckets.length / AXIS_LABELS);
  // Counted back from today, so the labels never crowd the last one.
  return (buckets.length - 1 - index) % step === 0
    ? formatDate(bucket.start, overview.timeZone)
    : undefined;
};

// The time the first day bar counts from when it starts before the period, as
// a trailing 7- or 30-day period's first bar does; else undefined.
const firstBarFrom = ({ chart, from }: AgentsOverview): number | undefined => {
  const first = chart.buckets[0];
  return chart.unit === 'day' && first !== undefined && first.start < from ? from : undefined;
};

// A bar's name for a hover and the chart's text alternative.
const barName = (overview: AgentsOverview, index: number): string => {
  const { buckets, unit } = overview.chart;
  const start = buckets[index]?.start ?? 0;
  if (unit === 'hour') {
    return `${formatClock(start, overview.timeZone)}${index === buckets.length - 1 ? ' (so far)' : ''}`;
  }
  if (index === buckets.length - 1) {
    return 'Today (so far)';
  }
  const from = index === 0 ? firstBarFrom(overview) : undefined;
  return from === undefined
    ? formatDate(start, overview.timeZone)
    : `${formatDate(start, overview.timeZone)} (from ${formatClock(from, overview.timeZone)})`;
};

// Which bars count only part of their hour or day, for the chart's heading.
const partialNote = (overview: AgentsOverview): string => {
  if (overview.chart.unit === 'hour') {
    return 'the current hour is partial';
  }
  const from = firstBarFrom(overview);
  return from === undefined
    ? "today's bar is partial"
    : `the first bar counts from ${formatClock(from, overview.timeZone)}, and today's is partial`;
};

// One bar: its segments stacked from the bottom, each as tall as its cost on
// the value scale. With a pick, the segments of the other keys dim.
function Bar({
  dimmed,
  domain,
  stack,
  title,
  usual,
}: {
  dimmed: (key: string) => boolean;
  domain: Domain;
  stack: BarStack;
  title: string;
  usual: number | undefined;
}) {
  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col-reverse" title={title}>
      {stack.segments.map((segment) => (
        <span
          className="block min-h-px w-full first:rounded-b-[2px] last:rounded-t-[2px]"
          key={segment.key}
          style={{
            background: segment.color,
            height: `${String(100 - yPercent(segment.pricedCostUsd, domain))}%`,
            opacity: dimmed(segment.key) ? 0.25 : 1,
          }}
        />
      ))}
      {usual !== undefined && (
        <span
          aria-hidden="true"
          className="absolute -inset-x-px border-t-2 border-dashed border-foreground"
          data-usual-by-now={usual}
          style={{ bottom: `${String(100 - yPercent(usual, domain))}%` }}
        />
      )}
    </div>
  );
}

// The cost of each local day, or for Today each local hour, split by `by`
// into the keys of the legend, which sits above it. Today's bar is partial and
// in the day views carries a dashed mark at what is usually spent by now; the
// first day bar of the 7- and 30-day periods is partial too, counting from
// the period's start, and the heading says so.
export function AgentsChart({
  by,
  overview,
  pick,
}: {
  by: AgentsBreakdown;
  overview: AgentsOverview;
  pick: string | undefined;
}) {
  const { buckets, cells, unit } = overview.chart;
  const rows = breakdownRows(overview, by);
  const stacks = barStacks(cells, buckets.length, by, rows);
  const usual = unit === 'day' ? overview.usualByNow : undefined;
  const domain = costDomain(Math.max(0, usual ?? 0, ...stacks.map(({ total }) => total)));
  // The merged "others" segment is lit only while the pick is one of them.
  const pickedColor = rows.find((row) => row.key === pick)?.color;
  const dimmed = (key: string) =>
    pick !== undefined && (key === OTHERS_KEY ? pickedColor !== NEUTRAL_COLOR : key !== pick);
  const per = unit === 'hour' ? 'hour' : 'day';
  const summary = stacks
    .map(({ total }, index) => `${barName(overview, index)} ${formatCost(total)}`)
    .join(', ');
  return (
    <section aria-labelledby="agents-chart-heading" className="card-surface rounded-xl border p-4">
      <h2
        className="flex flex-wrap items-baseline gap-x-3 text-base font-semibold"
        id="agents-chart-heading"
      >
        Cost per {per}, by {SWITCH_LABELS[by]}
        <span className="text-sm font-normal text-muted-foreground">
          {partialNote(overview)}
          {usual === undefined ? '' : ' · dashed: usual by now'}
        </span>
      </h2>
      <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="shrink-0">
          <AgentsBreakdownSwitch current={by} />
        </div>
        <AgentsLegend key={by} pick={pick} rows={rows} />
      </div>
      <div className="mt-4">
        <ScaledPlot domain={domain} format={dollars} gutter height={190}>
          <div aria-hidden="true" className="absolute inset-0">
            {scaleTicks(domain).map(({ y }) => (
              <div
                className="absolute inset-x-0 border-t border-border/60"
                key={y}
                style={{ top: `${String(y)}%` }}
              />
            ))}
          </div>
          <div
            aria-label={`Cost per ${per} by ${SWITCH_LABELS[by]}: ${summary}`}
            className="absolute inset-0 flex items-stretch gap-[3px]"
            role="img"
          >
            {stacks.map((stack, index) => (
              <Bar
                dimmed={dimmed}
                domain={domain}
                key={buckets[index]?.start ?? index}
                stack={stack}
                title={`${barName(overview, index)}: ${formatCost(stack.total)}`}
                usual={index === stacks.length - 1 ? usual : undefined}
              />
            ))}
          </div>
        </ScaledPlot>
        <div aria-hidden="true" className="flex gap-[3px] pt-1 pl-8 text-xs text-dim">
          {buckets.map((bucket, index) => (
            <span className="relative h-4 min-w-0 flex-1" key={bucket.start}>
              <span className="absolute right-0 whitespace-nowrap tabular-nums">
                {axisLabel(overview, index)}
              </span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
