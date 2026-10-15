import { SYSTEM_NAME } from '@heimdall/schema';
import { configHome, readConfigSection } from '@heimdall/service';
import { z } from 'zod';

export const DISK_LIMITS = { alert: 90, hysteresis: 5, note: 70, warning: 80 };
export type DiskLimits = typeof DISK_LIMITS;

const percentage = z.number().finite().min(0).max(100);
const partialDisk = z.strictObject({
  alert: percentage.optional(),
  hysteresis: percentage.positive().optional(),
  note: percentage.optional(),
  warning: percentage.optional(),
});

const systemOverrides = z.strictObject({ disk: partialDisk.optional() });
const section = z.strictObject({
  disk: partialDisk.optional(),
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
  const disk = validateDisk(mergeDisk(DISK_LIMITS, parsed.disk), 'conditions.disk');
  const systems = new Map(
    Object.entries(parsed.systems ?? {}).map(([system, override]) => [
      system,
      validateDisk(mergeDisk(disk, override.disk), `conditions.systems.${system}.disk`),
    ]),
  );
  return { disk, systems };
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
