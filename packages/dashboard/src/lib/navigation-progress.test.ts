import { describe, expect, test } from 'bun:test';

import { FINISH_MS, SHOW_AFTER_MS, trackNavigation } from './navigation-progress.ts';
import type { NavigationPhase } from './navigation-progress.ts';

// A tracker on a clock a test moves by hand, with every phase it reported.
const tracked = () => {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  const phases: NavigationPhase[] = [];
  const tracker = trackNavigation(
    (phase) => {
      phases.push(phase);
    },
    {
      after: (run, ms) => {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return () => {
          timers = timers.filter((other) => other !== timer);
        };
      },
    },
  );
  return {
    elapse: (ms: number) => {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) {
        timer.run();
      }
    },
    phases,
    tracker,
    waiting: () => timers.length,
  };
};

describe('trackNavigation', () => {
  test('a page that arrives before the wait is over shows nothing', () => {
    const { elapse, phases, tracker } = tracked();
    tracker.update(true);
    elapse(SHOW_AFTER_MS - 1);
    tracker.update(false);
    elapse(SHOW_AFTER_MS + FINISH_MS);
    expect(phases).toEqual([]);
  });

  test('a page still loading after the wait shows the line until it arrives, then the finish', () => {
    const { elapse, phases, tracker } = tracked();
    tracker.update(true);
    elapse(SHOW_AFTER_MS);
    expect(phases).toEqual(['loading']);
    elapse(3000);
    tracker.update(false);
    expect(phases).toEqual(['loading', 'done']);
    elapse(FINISH_MS);
    expect(phases).toEqual(['loading', 'done', 'idle']);
  });

  test('a page asked for while the last line is finishing starts its own line from the beginning', () => {
    const { elapse, phases, tracker } = tracked();
    tracker.update(true);
    elapse(SHOW_AFTER_MS);
    tracker.update(false);
    elapse(FINISH_MS / 2);
    tracker.update(true);
    expect(phases).toEqual(['loading', 'done', 'idle']);
    elapse(SHOW_AFTER_MS);
    expect(phases).toEqual(['loading', 'done', 'idle', 'loading']);
  });

  test('a stopped tracker reports nothing more', () => {
    const { elapse, phases, tracker, waiting } = tracked();
    tracker.update(true);
    tracker.stop();
    elapse(SHOW_AFTER_MS);
    expect({ phases, waiting: waiting() }).toEqual({ phases: [], waiting: 0 });
  });
});
