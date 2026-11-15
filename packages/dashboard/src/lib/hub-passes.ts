import type { HubCheckState } from '../server/hub-status-types.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { formatSpan, formatSpanShort } from './time.ts';

// What the Hub's status row holds for one timer pass, in epoch milliseconds
// (packages/hub/src/hub-status.ts): its schedule, when its latest run started
// and finished, when one last succeeded, and, while its runs keep failing,
// when the first of them failed.
export type PassRecord = {
  interval_ms?: number;
  budget_ms?: number;
  started_at?: number;
  finished_at?: number;
  succeeded_at?: number;
  failing_since?: number;
};

export type PassJudgment = {
  state: HubCheckState;
  phrase: Phrase;
  // Whether the pass has fallen behind its schedule or keeps failing.
  stuck: boolean;
};

// "12 s ago", in the largest unit.
export const agoText = (at: number, now: number) => `${formatSpanShort(Math.max(0, now - at))} ago`;

const isRunning = (run: PassRecord) =>
  run.started_at !== undefined &&
  (run.finished_at === undefined || run.started_at > run.finished_at);

// The Hub starts the next run one interval after the last finished, so a
// pass is late only when it is not running, no run has started within twice
// its interval plus its budget, and none has finished within twice its
// interval, the last of which covers a long run that just ended. A pass that
// never started counts from when the Hub started.
export const isOverdue = (run: PassRecord, now: number, hubStartedAt: number) => {
  if (isRunning(run) || run.interval_ms === undefined) {
    return false;
  }
  const interval = run.interval_ms;
  const startLimit = 2 * interval + (run.budget_ms ?? 0);
  const started = run.started_at ?? hubStartedAt;
  return (
    now - started > startLimit &&
    (run.finished_at === undefined || now - run.finished_at > 2 * interval)
  );
};

// How one pass stands, as a sentence led by `label`, such as "Parse pass". A
// pass the row does not hold is unknown. While the Hub is `down`, nothing is
// judged late: the page says once that the Hub is not running, and each pass
// only says when it last ran.
export const judgePass = ({
  down,
  hubStartedAt,
  label,
  now,
  run,
}: {
  down: boolean;
  hubStartedAt: number | undefined;
  label: string;
  now: number;
  run: PassRecord | undefined;
}): PassJudgment => {
  if (run === undefined || hubStartedAt === undefined) {
    return { phrase: [`${label} unknown`], state: 'unknown', stuck: false };
  }
  const ran =
    run.finished_at === undefined ? 'not run yet' : `ran ${agoText(run.finished_at, now)}`;
  if (down) {
    return {
      phrase: [`${label} ${ran === 'not run yet' ? ran : `last ${ran}`}`],
      state: 'unknown',
      stuck: false,
    };
  }
  if (isRunning(run) && run.started_at !== undefined) {
    return {
      phrase: [`${label} running for ${formatSpan(now - run.started_at)}`],
      state: 'ok',
      stuck: false,
    };
  }
  if (run.failing_since !== undefined) {
    return {
      phrase: [
        `${label} failing since `,
        whenAt(run.failing_since, now),
        ` (${formatSpanShort(Math.max(0, now - run.failing_since))})`,
      ],
      state: 'warning',
      stuck: true,
    };
  }
  if (isOverdue(run, now, hubStartedAt)) {
    const since =
      run.started_at === undefined
        ? `has not run since the Hub started ${agoText(hubStartedAt, now)}`
        : `overdue: last started ${agoText(run.started_at, now)}`;
    return { phrase: [`${label} ${since}`], state: 'warning', stuck: true };
  }
  return { phrase: [`${label} ${ran}`], state: 'ok', stuck: false };
};
