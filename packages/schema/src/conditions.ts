import { z } from 'zod';

export const OLD_EVIDENCE_MS = 2 * 60 * 60_000;

export const ConditionLevelSchema = z.enum(['note', 'warning', 'alert']);
export type ConditionLevel = z.infer<typeof ConditionLevelSchema>;

export type ConditionTransition = {
  at: number;
  backfilled: boolean;
  level: ConditionLevel;
  reason: string;
} & ({ kind: 'raised' | 'cleared' } | { kind: 'level_changed'; previousLevel: ConditionLevel });
