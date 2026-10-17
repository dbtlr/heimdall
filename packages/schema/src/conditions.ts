import { z } from 'zod';

export const OLD_EVIDENCE_MS = 2 * 60 * 60_000;

// Keeps one wrongly future-dated sample from hiding usable current evidence.
export const FUTURE_SAMPLE_TOLERANCE_MS = 5 * 60_000;

export const ConditionLevelSchema = z.enum(['note', 'warning', 'alert']);
export type ConditionLevel = z.infer<typeof ConditionLevelSchema>;

export type ConditionTransition = {
  at: number;
  backfilled: boolean;
  level: ConditionLevel;
  reason: string;
} & ({ kind: 'raised' | 'cleared' } | { kind: 'level_changed'; previousLevel: ConditionLevel });

// The limits the Hub judges a System's Conditions by now: the fleet's limits with
// that System's overrides merged in, as the Hub stores them in
// condition_limits. Percentages are 0 to 100; durations are minutes or days.
export type ConditionLimitSet = {
  cpu: {
    noteMinutes: number;
    noteWindowMinutes: number;
    percent: number;
    warningMinutes: number;
    warningWindowMinutes: number;
  };
  disk: { alert: number; hysteresis: number; note: number; warning: number };
  memory: { percent: number; warningMinutes: number; warningWindowMinutes: number };
  process: {
    cores: number;
    noteMinutes: number;
    noteWindowMinutes: number;
    warningMinutes: number;
    warningWindowMinutes: number;
  };
  updates: { rebootWarningDays: number; securityWarningDays: number };
};
