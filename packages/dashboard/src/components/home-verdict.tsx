import type { HomeVerdict, VerdictLevel } from '../lib/home.ts';
import { cn } from '../lib/utils.ts';
import { PhraseText } from './date-time.tsx';

// The card's left edge: the worst open level's color, the healthy green, or
// the plain border while there is no System to judge.
const EDGE: Record<VerdictLevel, string> = {
  alert: 'border-l-status-critical',
  empty: 'border-l-border',
  healthy: 'border-l-status-good',
  warning: 'border-l-status-serious',
};

// One figure: its value over its whole, with what it counts under them.
function Figure({ label, of, value }: { label: string; of: number; value: number }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-[19px] leading-tight font-semibold tabular-nums">
        {value}
        <span className="text-[13px] font-normal text-dim"> / {of}</span>
      </dd>
    </div>
  );
}

// Home's first card: the verdict sentence, the facts behind it, and the
// fleet's figures beside them, stacked on a phone. The figures sit in a row
// that holds more as they come.
export function HomeVerdictCard({
  figures,
  verdict,
}: {
  figures: { awake: number; services: number; servicesUp: number; systems: number };
  verdict: HomeVerdict;
}) {
  return (
    <section
      aria-labelledby="home-verdict"
      className={cn(
        'grid gap-3 card-surface rounded-xl border border-l-[3px] px-4 py-3.5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-8 lg:px-5',
        EDGE[verdict.level],
      )}
    >
      <div className="min-w-0">
        <h2
          className="text-[21px] leading-tight font-semibold tracking-[-0.01em] wrap-anywhere"
          id="home-verdict"
        >
          {verdict.sentence}
        </h2>
        {verdict.support.length > 0 && (
          <p className="mt-1 text-[13.5px] text-muted-foreground wrap-anywhere">
            <PhraseText phrase={verdict.support} />
          </p>
        )}
      </div>
      {figures.systems > 0 && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:flex sm:flex-wrap sm:gap-x-8 lg:justify-end">
          <Figure label="Systems awake" of={figures.systems} value={figures.awake} />
          <Figure label="Services up" of={figures.services} value={figures.servicesUp} />
        </dl>
      )}
    </section>
  );
}
