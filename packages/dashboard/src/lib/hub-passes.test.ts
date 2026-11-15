import { expect, test } from 'bun:test';

import { isOverdue, judgePass } from './hub-passes.ts';
import { phraseText } from './phrase.ts';

const T = 1_800_000_000_000;
const ZONE = 'UTC';

// The schedules serve records (PASS_SCHEDULES in packages/hub/src/serve.ts),
// with the time from a run's start past which a pass that is not running is
// overdue: twice its interval plus its budget.
const OVERDUE_AFTER = {
  conditions: [{ budget_ms: 30_000, interval_ms: 60_000 }, 150_000],
  delivery: [{ budget_ms: 30_000, interval_ms: 30_000 }, 90_000],
  listening: [{ budget_ms: 30_000, interval_ms: 30_000 }, 90_000],
  parse: [{ budget_ms: 30_000, interval_ms: 15_000 }, 60_000],
  prune: [{ budget_ms: 30_000, interval_ms: 3_600_000 }, 7_230_000],
  refresh: [{ budget_ms: 40_000, interval_ms: 15_000 }, 70_000],
  upstreams: [{ budget_ms: 30_000, interval_ms: 300_000 }, 630_000],
} as const;

test.each(Object.entries(OVERDUE_AFTER))(
  'the %s pass is overdue only once no run has started within twice its interval plus its budget',
  (_, [schedule, limit]) => {
    const run = { ...schedule, finished_at: T, started_at: T };
    expect(isOverdue(run, T + limit, T)).toBe(false);
    expect(isOverdue(run, T + limit + 1, T)).toBe(true);
  },
);

test('a run that took longer than its budget is not overdue until two intervals after it finished', () => {
  const run = { budget_ms: 30_000, finished_at: T + 200_000, interval_ms: 15_000, started_at: T };
  expect(isOverdue(run, T + 230_000, T)).toBe(false);
  expect(isOverdue(run, T + 230_001, T)).toBe(true);
});

test('a pass still running is never overdue, and says how long it has run', () => {
  const run = { budget_ms: 30_000, finished_at: T, interval_ms: 15_000, started_at: T + 1000 };
  const now = T + 86_400_000;
  expect(isOverdue(run, now, T)).toBe(false);
  const judged = judgePass({
    down: false,
    hubStartedAt: T,
    label: 'Parse pass',
    now: T + 41_000,
    run,
  });
  expect(judged).toEqual({ phrase: ['Parse pass running for 40 s'], state: 'ok', stuck: false });
});

test.each(Object.entries(OVERDUE_AFTER))(
  'a run of the %s pass reads as hung only once it has run longer than twice its interval plus its budget',
  (_, [schedule, limit]) => {
    const run = { ...schedule, finished_at: T - 1000, started_at: T };
    const judge = (now: number) =>
      judgePass({ down: false, hubStartedAt: T - 60_000, label: 'Pass', now, run });
    expect(judge(T + limit)).toMatchObject({ state: 'ok', stuck: false });
    const hung = judge(T + limit + 1);
    expect(hung).toMatchObject({ state: 'warning', stuck: true });
    expect(phraseText(hung.phrase, ZONE)).toMatch(
      /^Pass running for .+, longer than its usual most$/u,
    );
  },
);

test('a first run that never finishes reads as hung past its limit', () => {
  const run = { budget_ms: 30_000, interval_ms: 15_000, started_at: T };
  const judged = judgePass({
    down: false,
    hubStartedAt: T,
    label: 'Parse pass',
    now: T + 3 * 60_000,
    run,
  });
  expect(judged).toEqual({
    phrase: ['Parse pass running for 3 min, longer than its usual most'],
    state: 'warning',
    stuck: true,
  });
});

test('a failing pass reads as failing while it runs again, and says for how long', () => {
  const run = {
    budget_ms: 30_000,
    failing_since: T - 5 * 60_000,
    finished_at: T - 10_000,
    interval_ms: 60_000,
    started_at: T - 3000,
  };
  const judged = judgePass({
    down: false,
    hubStartedAt: T - 86_400_000,
    label: 'Condition evaluation',
    now: T,
    run,
  });
  expect(judged).toMatchObject({ state: 'warning', stuck: true });
  expect(phraseText(judged.phrase, ZONE)).toBe(
    'Condition evaluation failing since 07:55 (5 min); running again for 3 s',
  );
});

test('limits are judged as of `asOf`, while ages are told from now', () => {
  const run = { budget_ms: 30_000, finished_at: T, interval_ms: 15_000, started_at: T - 100 };
  const judge = (asOf: number) =>
    judgePass({
      asOf,
      down: false,
      hubStartedAt: T - 60_000,
      label: 'Parse pass',
      now: T + 65_000,
      run,
    });
  expect(judge(T + 30_000)).toEqual({
    phrase: ['Parse pass ran 1 min ago'],
    state: 'ok',
    stuck: false,
  });
  expect(judge(T + 65_000).state).toBe('warning');
  const running = { ...run, started_at: T + 1000 };
  expect(
    judgePass({
      asOf: T + 30_000,
      down: false,
      hubStartedAt: T - 60_000,
      label: 'Parse pass',
      now: T + 3 * 60_000,
      run: running,
    }),
  ).toEqual({ phrase: ['Parse pass running for 2 min'], state: 'ok', stuck: false });
});

test('a pass that keeps failing reads as failing since its first failure, however recent its last run', () => {
  const run = {
    budget_ms: 30_000,
    failing_since: T - 18 * 60_000,
    finished_at: T - 1000,
    interval_ms: 60_000,
    started_at: T - 2000,
    succeeded_at: T - 3_600_000,
  };
  const judged = judgePass({
    down: false,
    hubStartedAt: T - 86_400_000,
    label: 'Condition evaluation',
    now: T,
    run,
  });
  expect(judged.state).toBe('warning');
  expect(phraseText(judged.phrase, ZONE)).toBe('Condition evaluation failing since 07:42 (18 min)');
});

test('a pass that never started counts from when the Hub started', () => {
  const run = { budget_ms: 30_000, interval_ms: 60_000 };
  const judge = (now: number) =>
    judgePass({ down: false, hubStartedAt: T, label: 'Prune', now, run });
  expect(phraseText(judge(T + 150_000).phrase, ZONE)).toBe('Prune not run yet');
  expect(phraseText(judge(T + 150_001).phrase, ZONE)).toBe(
    'Prune has not run since the Hub started 2 min ago',
  );
});

test('a current pass says how long ago it ran; a Hub that is down judges nothing late', () => {
  const run = {
    budget_ms: 30_000,
    finished_at: T - 12_000,
    interval_ms: 15_000,
    started_at: T - 13_000,
  };
  const current = judgePass({
    down: false,
    hubStartedAt: T - 60_000,
    label: 'Parse pass',
    now: T,
    run,
  });
  expect(current).toEqual({ phrase: ['Parse pass ran 12 s ago'], state: 'ok', stuck: false });
  const down = judgePass({
    down: true,
    hubStartedAt: T - 60_000,
    label: 'Parse pass',
    now: T + 3 * 3_600_000,
    run,
  });
  expect(down).toEqual({ phrase: ['Parse pass last ran 3 h ago'], state: 'unknown', stuck: false });
  expect(
    judgePass({ down: false, hubStartedAt: undefined, label: 'Parse pass', now: T, run }).state,
  ).toBe('unknown');
});
