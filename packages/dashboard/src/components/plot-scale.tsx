import { useId } from 'react';
import type { ReactNode } from 'react';

import { scaleTicks, yPercent } from '../lib/chart-scale.ts';
import type { Domain } from '../lib/chart-scale.ts';
import { cn } from '../lib/utils.ts';

// The color of a line that carries no level or Harness: CPU, memory.
export const PLOT_COLOR = 'var(--plot)';

// A limit drawn across a plot: a dashed line at its value, labelled with it.
export type PlotLimit = { color: string; label: string; value: number };

// The percentages a CPU or memory plot shows, 0 at the bottom to 100 at the top.
export const PERCENT_DOMAIN: Domain = [0, 100];

const percentLabel = (value: number): string => String(Math.round(value));

// A vertical gradient of `color`, strong at the top and clear at the bottom,
// for the area under a plot's line. The fill is `url(#<id>)`. It lives in its
// own empty SVG so a Recharts chart and a hand-drawn SVG can both refer to it.
export function PlotGradient({ color, id }: { color: string; id: string }) {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute size-0 overflow-hidden">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.42} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
    </svg>
  );
}

// A gradient id unique to the plot, safe inside `url(#…)`.
export const usePlotGradientId = (): string => `plot-fill-${useId().replaceAll(/[^\w-]/gu, '')}`;

// Where a label sits against its line: the top label hangs below the top
// edge, the bottom one stands on the bottom edge, the rest centre on theirs.
const tickShift = (y: number): string => {
  if (y <= 0) {
    return '';
  }
  return y >= 100 ? '-translate-y-full' : '-translate-y-1/2';
};

// A label laid over a plot sits on a backing in the card's color, so the line
// passes behind it instead of through it.
const BACKING = 'rounded-sm bg-card/85 px-0.5';

// The labels of a plot's value scale, each `y` percent down the layer, the
// same place the plot draws that value.
function ScaleTicks({
  beside = false,
  domain,
  format,
}: {
  beside?: boolean;
  domain: Domain;
  format: (value: number) => string;
}) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {scaleTicks(domain).map(({ value, y }) => (
        <span
          className={cn(
            'absolute text-xs leading-none text-dim tabular-nums',
            beside ? 'right-full mr-1.5 whitespace-nowrap' : cn('left-1', BACKING),
            tickShift(y),
          )}
          data-scale-tick={value}
          key={y}
          style={{ top: `${String(y)}%` }}
        >
          {format(value)}
        </span>
      ))}
    </div>
  );
}

// A dashed line across the plot at each limit, labelled at the right end in
// the limit's color.
function LimitLines({ domain, limits }: { domain: Domain; limits: readonly PlotLimit[] }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {limits.map((limit) => {
        const y = yPercent(limit.value, domain);
        return (
          <div
            className="absolute inset-x-0 border-t border-dashed opacity-90"
            data-limit={limit.value}
            key={`${limit.label}-${String(limit.value)}`}
            style={{ borderColor: limit.color, top: `${String(y)}%` }}
          >
            <span
              className={cn(
                'absolute right-1 text-xs leading-none font-medium',
                BACKING,
                // Below its line, so stacked limits keep their labels apart,
                // unless that would leave the plot.
                y > 85 ? 'bottom-1' : 'top-1',
              )}
              style={{ color: limit.color }}
            >
              {limit.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// A plot with its value scale and limits, `height` pixels tall. A plot on a
// shared time axis carries its scale over its left end; one standing alone
// takes a `gutter` for it, left of the plot. A plot whose domain is a stand-in,
// because it has no reading to scale, is not `labelled`.
export function ScaledPlot({
  beside = false,
  children,
  className,
  domain,
  format = percentLabel,
  gutter = false,
  height,
  labelled = true,
  limits = [],
}: {
  // Draws the scale in the gutter the caller leaves left of the plot, right-aligned.
  beside?: boolean;
  children: ReactNode;
  className?: string;
  domain: Domain;
  format?: (value: number) => string;
  gutter?: boolean;
  height: number;
  labelled?: boolean;
  limits?: readonly PlotLimit[];
}) {
  if (!gutter) {
    return (
      <div className={cn('relative w-full', className)} style={{ height }}>
        {children}
        {labelled && <ScaleTicks beside={beside} domain={domain} format={format} />}
        <LimitLines domain={domain} limits={limits} />
      </div>
    );
  }
  return (
    <div className={cn('relative w-full pl-8', className)} style={{ height }}>
      <div className="absolute inset-y-0 left-0 w-8">
        {labelled && <ScaleTicks domain={domain} format={format} />}
      </div>
      <div className="relative h-full">
        {children}
        <LimitLines domain={domain} limits={limits} />
      </div>
    </div>
  );
}
