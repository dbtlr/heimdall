import type { ConditionDetailView, HistoryRow } from '../lib/condition-detail.ts';
import { cn } from '../lib/utils.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { ConditionChart } from './condition-chart.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { DateTime, PhraseText } from './date-time.tsx';

const CHIP =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-semibold';

const COMMAND =
  'mt-1 block rounded bg-background px-2 py-1 font-mono text-[12.5px] break-all whitespace-pre-wrap';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The title, the level the Hub stored, and whether it has cleared.
function Heading({ view }: { view: ConditionDetailView }) {
  return (
    <header className="min-w-0">
      <h1 className="text-[26px] leading-tight font-semibold wrap-anywhere">{view.title}</h1>
      <p className="mt-2 flex flex-wrap items-center gap-2">
        <span className={cn(CHIP, MARK_COLOR[view.level])}>
          <ConditionGlyph kind={view.level} />
          {capitalize(view.level)}
        </span>
        {view.cleared && (
          <span className={cn(CHIP, 'text-muted-foreground')}>
            <ConditionGlyph kind="cleared" />
            Cleared
          </span>
        )}
      </p>
    </header>
  );
}

// The number the page leads with, with its unit and the sentence it starts,
// and for a disk the estimate of how fast it fills.
function Hero({ view }: { view: ConditionDetailView }) {
  const { hero, rate } = view;
  return (
    <section aria-label="Reading" className="mt-5 min-w-0">
      <p className="flex items-baseline gap-1.5">
        <span className="text-[64px] leading-none font-semibold tabular-nums">{hero.value}</span>
        <span className="text-xl text-muted-foreground">{hero.unit}</span>
      </p>
      <p className="mt-2 text-base wrap-anywhere">
        <PhraseText phrase={hero.text} />
      </p>
      {rate !== undefined && (
        <p className="mt-2 text-base wrap-anywhere">
          {rate.text}{' '}
          <span className="inline-block rounded-full border px-2 text-xs text-muted-foreground">
            Estimate
          </span>
        </p>
      )}
    </section>
  );
}

function ChartSection({ chart }: { chart: NonNullable<ConditionDetailView['chart']> }) {
  const { left, right, rule } = chart.captions;
  return (
    <section className="mt-5 min-w-0">
      <ConditionChart chart={chart} />
      <p className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
        <span>{left}</span>
        <span>{right}</span>
      </p>
      {rule !== undefined && <p className="mt-1 text-xs text-muted-foreground">{rule}</p>}
    </section>
  );
}

// One transition: the level it reached, when, and what the Hub said.
function HistoryItem({ now, row }: { now: number; row: HistoryRow }) {
  return (
    <li className="flex min-w-0 items-start gap-2.5 py-1.5">
      <ConditionGlyph className="mt-1.5" kind={row.level === 'cleared' ? 'cleared' : row.level} />
      <div className="min-w-0">
        <p className="font-semibold wrap-anywhere">{row.label}</p>
        <p className="text-sm text-muted-foreground">
          <DateTime at={row.at} format="when" now={now} />
          {row.backfilled && ', Backfilled level'}
        </p>
        {row.reason !== undefined && (
          <p className="text-sm whitespace-pre-wrap text-muted-foreground wrap-anywhere">
            {row.reason}
          </p>
        )}
      </div>
    </li>
  );
}

function NextStep({ nextStep }: { nextStep: NonNullable<ConditionDetailView['nextStep']> }) {
  const { clears, steps } = nextStep;
  return (
    <section className="mt-6 min-w-0 text-base">
      {steps.map((step, index) => (
        <div className={index === 0 ? '' : 'mt-3'} key={step.title}>
          <p className="wrap-anywhere">
            <b className="font-semibold">{steps.length > 1 ? `${step.title}.` : 'Next step.'}</b>{' '}
            {step.text}
          </p>
          {step.commands.map((command) => (
            <code className={COMMAND} key={command}>
              {command}
            </code>
          ))}
        </div>
      ))}
      {clears !== undefined && <p className="mt-3 wrap-anywhere">{clears}</p>}
    </section>
  );
}

// An opened Condition: what it is, what it reads, how it got here, and what
// to do. Phone-first: one column that wraps instead of scrolling sideways.
export function ConditionDetailPanel({ now, view }: { now: number; view: ConditionDetailView }) {
  return (
    <article className="min-w-0 py-4">
      <Heading view={view} />
      <Hero view={view} />
      {view.chart !== undefined && <ChartSection chart={view.chart} />}
      <section className="mt-6 min-w-0">
        <h2 className="mb-1 text-[12.5px] font-normal text-muted-foreground">How it got here</h2>
        <ol className="border-l-2 pl-3">
          {view.history.map((row, index) => (
            // The Hub's recording order distinguishes transitions at the same time.
            // oxlint-disable-next-line react/no-array-index-key
            <HistoryItem key={index} now={now} row={row} />
          ))}
        </ol>
      </section>
      {view.nextStep !== undefined && <NextStep nextStep={view.nextStep} />}
      {view.evidenceNote !== undefined && (
        <p className="mt-4 text-sm text-muted-foreground wrap-anywhere">
          <PhraseText phrase={view.evidenceNote} />
        </p>
      )}
      {view.provenance !== '' && (
        <p className="mt-4 text-xs text-muted-foreground wrap-anywhere">{view.provenance}</p>
      )}
    </article>
  );
}
