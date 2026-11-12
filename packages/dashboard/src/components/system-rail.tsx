import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import {
  ATTENTION_NAMES,
  attentionMark,
  evidenceWords,
  rankAttention,
  subjectText,
  withoutNotesShownElsewhere,
} from '../lib/attention.ts';
import { jobLine, serviceLine, SUPERVISOR_NAMES } from '../lib/recorded.ts';
import { formatSpanShort } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import type { Recorded } from '../server/system-detail-types.ts';
import { AttentionLink } from './attention-link.tsx';
import { MARK_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { PhraseText } from './date-time.tsx';
import { RECORD_DOT } from './recorded-panel.tsx';

// One card of the right rail: an eyebrow heading with a count, and its body.
function RailCard({
  children,
  count,
  id,
  title,
}: {
  children: ReactNode;
  count: number;
  id: string;
  title: string;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0 card-surface rounded-xl border px-4 py-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-dim uppercase" id={id}>
          {title}
        </h2>
        <span className="text-xs text-dim tabular-nums">{count}</span>
      </div>
      {children}
    </section>
  );
}

const ROW = 'border-t py-2 first:border-t-0 first:pt-0 last:pb-0';

// The System's open Conditions, the most severe first: its Pending update and
// Reboot required notes wait under the charts instead.
export function RailConditions({ items, now }: { items: readonly Attention[]; now: number }) {
  const { confirmed, unconfirmed } = rankAttention(withoutNotesShownElsewhere(items));
  const open = [...confirmed, ...unconfirmed];
  return (
    <RailCard count={open.length} id="rail-conditions" title="Open Conditions">
      {open.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No open Condition or uncertain evidence.
        </p>
      ) : (
        <ul className="text-[13.5px]">
          {open.map((item) => {
            const mark = attentionMark(item);
            const subject = subjectText(item);
            return (
              <li className={ROW} key={`${item.kind}-${item.subject}-${item.conditionId ?? ''}`}>
                <AttentionLink className="block hover:underline" item={item}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className={cn('flex-none self-center', MARK_COLOR[mark])}>
                      <ConditionGlyph kind={mark} />
                    </span>
                    <b className="min-w-0 flex-1 font-semibold wrap-anywhere">
                      {ATTENTION_NAMES[item.kind]}
                      {subject !== '' && (
                        <span className="font-normal text-muted-foreground"> · {subject}</span>
                      )}
                    </b>
                    <span className="flex-none text-xs text-dim tabular-nums">
                      {formatSpanShort(Math.max(0, now - item.firstDetected))}
                    </span>
                  </span>
                  <span className="mt-0.5 block pl-6 text-xs text-muted-foreground">
                    <PhraseText phrase={evidenceWords(item, now).observedShort} />
                  </span>
                </AttentionLink>
              </li>
            );
          })}
        </ul>
      )}
    </RailCard>
  );
}

// The Services its provisioner recorded, each with the supervisor that runs it
// and, when it is not up, what the checks say.
export function RailServices({
  now,
  recorded,
  system,
}: {
  now: number;
  recorded: Recorded;
  system: string;
}) {
  const { services } = recorded;
  return (
    <RailCard count={services.length} id="rail-services" title="Services">
      {services.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Its provisioner recorded no Service.</p>
      ) : (
        <ul className="text-[13.5px]">
          {services.map((service) => {
            const { state, text } = serviceLine(service, now);
            return (
              <li className={ROW} key={service.name}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    className={cn('size-2 flex-none self-center rounded-full', RECORD_DOT[state])}
                  />
                  <Link
                    className="min-w-0 font-semibold wrap-anywhere text-primary"
                    params={{ name: system, service: service.name }}
                    to="/systems/$name/services/$service"
                  >
                    {service.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {SUPERVISOR_NAMES[service.supervisor] ?? service.supervisor}
                  </span>
                </span>
                {state !== 'good' && (
                  <span className="mt-0.5 block pl-4 text-xs wrap-anywhere text-muted-foreground">
                    <PhraseText phrase={text} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </RailCard>
  );
}

// The jobs its provisioner recorded, each with how its latest run went and
// when it is next due.
export function RailJobs({ now, recorded }: { now: number; recorded: Recorded }) {
  const { jobs } = recorded;
  return (
    <RailCard count={jobs.length} id="rail-jobs" title="Jobs">
      {jobs.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Its provisioner recorded no job.</p>
      ) : (
        <ul className="text-[13.5px]">
          {jobs.map((job) => {
            const { state, text } = jobLine(job, now);
            return (
              <li className={ROW} key={job.name}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    className={cn('size-2 flex-none self-center rounded-full', RECORD_DOT[state])}
                  />
                  <b className="min-w-0 flex-1 font-semibold wrap-anywhere">{job.name}</b>
                  {job.nextRunAt !== undefined && (
                    <span className="flex-none text-xs text-muted-foreground tabular-nums">
                      <PhraseText phrase={['next ', { at: job.nextRunAt, format: 'ahead', now }]} />
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block pl-4 text-xs wrap-anywhere text-muted-foreground">
                  <PhraseText phrase={text} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </RailCard>
  );
}
