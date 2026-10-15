import { SYSTEM_NAME } from '@heimdall/schema';
import { configHome, readConfigSection } from '@heimdall/service';
import { z } from 'zod';

import { RAW_RETENTION_MS } from './retention.ts';

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

const percentage = z.number().finite().min(0).max(100);
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
const systemOverrides = z.strictObject({
  cpu: partialCpu.optional(),
  disk: partialDisk.optional(),
  memory: partialMemory.optional(),
});
const section = z.strictObject({
  cpu: partialCpu.optional(),
  disk: partialDisk.optional(),
  memory: partialMemory.optional(),
  systems: z.record(z.string().regex(SYSTEM_NAME), systemOverrides).optional(),
});

// Non-overlapping recovery bands make a lower level's meaning independent
// of which higher level preceded it. A note must always be able to clear.
const validateDisk = (limits: DiskLimits, name: string): DiskLimits => {
  const { note, warning, alert, hysteresis } = limits;
  if (note <= hysteresis || warning - note <= hysteresis || alert - warning <= hysteresis) {
    throw new Error(
      `${name}: require 0 < hysteresis < note < warning < alert <= 100, with each level gap greater than hysteresis.`,
    );
  }
  return limits;
};

const mergeDisk = (
  defaults: DiskLimits,
  override: z.infer<typeof partialDisk> | undefined,
): DiskLimits => ({
  alert: override?.alert ?? defaults.alert,
  hysteresis: override?.hysteresis ?? defaults.hysteresis,
  note: override?.note ?? defaults.note,
  warning: override?.warning ?? defaults.warning,
});

export const parseConditionLimits = (value: unknown) => {
  const parsed = section.parse(value === undefined ? {} : value);
  const resolve = (
    defaults: {
      cpu: typeof CPU_LIMITS;
      disk: DiskLimits;
      memory: typeof MEMORY_LIMITS;
    },
    override: z.infer<typeof systemOverrides>,
    name: string,
  ) => {
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
    return {
      cpu,
      disk: validateDisk(mergeDisk(defaults.disk, override.disk), `${name}.disk`),
      memory,
    };
  };
  const defaults = resolve(
    { cpu: CPU_LIMITS, disk: DISK_LIMITS, memory: MEMORY_LIMITS },
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
