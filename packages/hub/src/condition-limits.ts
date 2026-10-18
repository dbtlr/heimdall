import { SYSTEM_NAME } from '@heimdall/schema';
import type { ConditionLevel, ConditionLimitSet } from '@heimdall/schema';
import { configHome, readConfigSection } from '@heimdall/service';
import type { SQL } from 'bun';
import { z } from 'zod';

import { MIGRATION_LOCK } from './migrations.ts';
import { RAW_RETENTION_MS } from './retention.ts';

// Clock skew limits in seconds, either direction.
export const CLOCK_LIMITS = { alert: 300, hysteresis: 5, note: 30, warning: 120 };
export type ClockLimits = typeof CLOCK_LIMITS;

export const DISK_LIMITS = { alert: 90, hysteresis: 5, note: 70, warning: 80 };
export type DiskLimits = typeof DISK_LIMITS;

export const CPU_LIMITS = {
  noteMinutes: 30,
  noteWindowMinutes: 60,
  percent: 90,
  warningMinutes: 120,
  warningWindowMinutes: 240,
};
export const MEMORY_LIMITS = { percent: 90, warningMinutes: 30, warningWindowMinutes: 60 };
export const PROCESS_LIMITS = {
  cores: 0.5,
  noteMinutes: 30,
  noteWindowMinutes: 60,
  warningMinutes: 120,
  warningWindowMinutes: 240,
};
export const UPDATE_LIMITS = { rebootWarningDays: 7, securityWarningDays: 3 };

const percentage = z.number().finite().min(0).max(100);
const seconds = z.number().finite().positive();
const partialClock = z.strictObject({
  alert: seconds.optional(),
  hysteresis: seconds.optional(),
  note: seconds.optional(),
  warning: seconds.optional(),
});
const partialDisk = z.strictObject({
  alert: percentage.optional(),
  hysteresis: percentage.positive().optional(),
  note: percentage.optional(),
  warning: percentage.optional(),
});

// Leave one day of raw retention for the predecessor that bounds an interval.
const minutes = z
  .number()
  .finite()
  .min(0.25)
  .max(RAW_RETENTION_MS / 60_000 - 1440);
const partialMemory = z.strictObject({
  percent: percentage.positive().optional(),
  warningMinutes: minutes.optional(),
  warningWindowMinutes: minutes.optional(),
});
const partialCpu = partialMemory.extend({
  noteMinutes: minutes.optional(),
  noteWindowMinutes: minutes.optional(),
});
const partialProcess = partialCpu.omit({ percent: true }).extend({
  cores: z.number().finite().positive().optional(),
});
const partialUpdates = z.strictObject({
  rebootWarningDays: z.number().finite().positive().max(3650).optional(),
  securityWarningDays: z.number().finite().positive().max(3650).optional(),
});
const systemOverrides = z.strictObject({
  clock: partialClock.optional(),
  cpu: partialCpu.optional(),
  disk: partialDisk.optional(),
  memory: partialMemory.optional(),
  process: partialProcess.optional(),
  updates: partialUpdates.optional(),
});
const section = z.strictObject({
  clock: partialClock.optional(),
  cpu: partialCpu.optional(),
  disk: partialDisk.optional(),
  memory: partialMemory.optional(),
  process: partialProcess.optional(),
  systems: z.record(z.string().regex(SYSTEM_NAME), systemOverrides).optional(),
  updates: partialUpdates.optional(),
});

// The limits of a measurement graded into levels: each level starts at its
// limit, and a lower level recovers a hysteresis below it.
export type Bands = { alert: number; hysteresis: number; note: number; warning: number };

const LEVELS = ['note', 'warning', 'alert'] as const;

// The level `value` falls in, or undefined when it falls in none. Escalation is
// immediate and includes equality. A level at or below the `current` one holds
// until `value` is a hysteresis below its limit, so a drop can skip levels or
// clear outright.
export const gradedLevel = (
  value: number,
  bands: Bands,
  current: ConditionLevel | undefined,
): ConditionLevel | undefined => {
  const currentRank = current === undefined ? -1 : LEVELS.indexOf(current);
  return LEVELS.toReversed().find(
    (level) =>
      value >= bands[level] ||
      (LEVELS.indexOf(level) <= currentRank && value >= bands[level] - bands.hysteresis),
  );
};

// Non-overlapping recovery bands make a lower level's meaning independent
// of which higher level preceded it. A note must always be able to clear.
// `top` ends the message's ordering, such as `alert <= 100`.
const validateBands = <T extends Bands>(limits: T, name: string, top: string): T => {
  const { note, warning, alert, hysteresis } = limits;
  if (note <= hysteresis || warning - note <= hysteresis || alert - warning <= hysteresis) {
    throw new Error(
      `${name}: require 0 < hysteresis < note < warning < ${top}, with each level gap greater than hysteresis.`,
    );
  }
  return limits;
};

type PartialBands = { [K in keyof Bands]?: Bands[K] | undefined };

const mergeBands = <T extends Bands>(defaults: T, override: PartialBands | undefined): T => ({
  ...defaults,
  alert: override?.alert ?? defaults.alert,
  hysteresis: override?.hysteresis ?? defaults.hysteresis,
  note: override?.note ?? defaults.note,
  warning: override?.warning ?? defaults.warning,
});

export const parseConditionLimits = (value: unknown) => {
  const parsed = section.parse(value === undefined ? {} : value);
  const resolve = (
    defaults: {
      clock: ClockLimits;
      cpu: typeof CPU_LIMITS;
      disk: DiskLimits;
      memory: typeof MEMORY_LIMITS;
      process: typeof PROCESS_LIMITS;
      updates: typeof UPDATE_LIMITS;
    },
    override: z.infer<typeof systemOverrides>,
    name: string,
  ): ConditionLimitSet => {
    const cpu = {
      noteMinutes: override.cpu?.noteMinutes ?? defaults.cpu.noteMinutes,
      noteWindowMinutes: override.cpu?.noteWindowMinutes ?? defaults.cpu.noteWindowMinutes,
      percent: override.cpu?.percent ?? defaults.cpu.percent,
      warningMinutes: override.cpu?.warningMinutes ?? defaults.cpu.warningMinutes,
      warningWindowMinutes: override.cpu?.warningWindowMinutes ?? defaults.cpu.warningWindowMinutes,
    };
    const memory = {
      percent: override.memory?.percent ?? defaults.memory.percent,
      warningMinutes: override.memory?.warningMinutes ?? defaults.memory.warningMinutes,
      warningWindowMinutes:
        override.memory?.warningWindowMinutes ?? defaults.memory.warningWindowMinutes,
    };
    const process = {
      cores: override.process?.cores ?? defaults.process.cores,
      noteMinutes: override.process?.noteMinutes ?? defaults.process.noteMinutes,
      noteWindowMinutes: override.process?.noteWindowMinutes ?? defaults.process.noteWindowMinutes,
      warningMinutes: override.process?.warningMinutes ?? defaults.process.warningMinutes,
      warningWindowMinutes:
        override.process?.warningWindowMinutes ?? defaults.process.warningWindowMinutes,
    };
    if (
      cpu.noteMinutes > cpu.noteWindowMinutes ||
      cpu.warningMinutes > cpu.warningWindowMinutes ||
      cpu.noteMinutes >= cpu.warningMinutes ||
      cpu.noteWindowMinutes > cpu.warningWindowMinutes
    ) {
      throw new Error(
        `${name}.cpu: durations must fit their windows and note must precede warning.`,
      );
    }
    if (memory.warningMinutes > memory.warningWindowMinutes) {
      throw new Error(`${name}.memory: warningMinutes must fit warningWindowMinutes.`);
    }
    if (
      process.noteMinutes > process.noteWindowMinutes ||
      process.warningMinutes > process.warningWindowMinutes ||
      process.noteMinutes >= process.warningMinutes ||
      process.noteWindowMinutes > process.warningWindowMinutes
    ) {
      throw new Error(
        `${name}.process: durations must fit their windows and note must precede warning.`,
      );
    }
    return {
      clock: validateBands(mergeBands(defaults.clock, override.clock), `${name}.clock`, 'alert'),
      cpu,
      disk: validateBands(mergeBands(defaults.disk, override.disk), `${name}.disk`, 'alert <= 100'),
      memory,
      process,
      updates: {
        rebootWarningDays:
          override.updates?.rebootWarningDays ?? defaults.updates.rebootWarningDays,
        securityWarningDays:
          override.updates?.securityWarningDays ?? defaults.updates.securityWarningDays,
      },
    };
  };
  const defaults = resolve(
    {
      clock: CLOCK_LIMITS,
      cpu: CPU_LIMITS,
      disk: DISK_LIMITS,
      memory: MEMORY_LIMITS,
      process: PROCESS_LIMITS,
      updates: UPDATE_LIMITS,
    },
    parsed,
    'conditions',
  );
  const systems = new Map(
    Object.entries(parsed.systems ?? {}).map(([system, override]) => [
      system,
      resolve(defaults, override, `conditions.systems.${system}`),
    ]),
  );
  return { ...defaults, systems };
};

export type ConditionLimits = ReturnType<typeof parseConditionLimits>;

export const readConditionLimits = async ({
  cwd,
  env,
  named,
}: {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  named: string | undefined;
}) =>
  parseConditionLimits(
    await readConfigSection({
      binary: 'hub',
      cwd,
      home: configHome(env),
      named,
      section: 'conditions',
    }),
  );

// Replaces the stored limits with these, so the dashboard draws the limits
// the Hub judges by. Takes the migration lock, as loading prices does.
export const storeConditionLimits = async (sql: SQL, limits: ConditionLimits): Promise<void> => {
  const { systems, ...defaults } = limits;
  const rows = [['', defaults] as const, ...systems].map(([system, effective]) => ({
    limits: effective,
    system,
  }));
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    await tx`DELETE FROM condition_limits`;
    await tx`
      INSERT INTO condition_limits (system, limits)
      SELECT system, limits FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)
        AS loaded (system text, limits jsonb)
    `;
  });
};
