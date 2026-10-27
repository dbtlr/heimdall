import type { ConditionLevel } from '@heimdall/schema';

import type { Attention, AttentionKind } from '../server/attention-types.ts';
import type { SystemGlance } from '../server/fleet-overview-types.ts';
import type { Disk } from '../server/system-detail-types.ts';
import { ATTENTION_NAMES, subjectText, withoutServiceRestartedNotes } from './attention.ts';
import { diskUsage, fullestDisk } from './facts.ts';
import { fleetAttention, isAsleep, levelCounts, worstActionLevel } from './fleet.ts';

// The resources a System tile draws a meter for.
export type Meter = 'cpu' | 'disk' | 'memory';

const METER_OF: Partial<Record<AttentionKind, Meter>> = {
  high_cpu: 'cpu',
  high_memory: 'memory',
  low_disk: 'disk',
};

const WORST_FIRST = ['alert', 'warning', 'note'] satisfies ConditionLevel[];

// The worst open level of the Conditions that hold on each resource, so a
// meter shows the level of what is wrong with it. A resource with none has no
// entry; evidence the Hub holds no Condition for has no level and colors nothing.
export const meterLevels = (
  items: readonly Attention[],
): Partial<Record<Meter, ConditionLevel>> => {
  const levels: Partial<Record<Meter, ConditionLevel>> = {};
  for (const item of items) {
    const meter = METER_OF[item.kind];
    if (meter === undefined || item.level === undefined) {
      continue;
    }
    const held = levels[meter];
    if (held === undefined || WORST_FIRST.indexOf(item.level) < WORST_FIRST.indexOf(held)) {
      levels[meter] = item.level;
    }
  }
  return levels;
};

// The "Can wait" shelf: for each name, in the order given, that has notes on a
// paired System, the notes as "Low disk /data" text. Names without notes are skipped.
export const canWaitRows = (
  names: readonly string[],
  items: readonly Attention[],
): { notes: string[]; system: string }[] => {
  const { notes } = fleetAttention(withoutServiceRestartedNotes(items));
  return names.flatMap((system) => {
    const texts = notes
      .filter((note) => note.system === system)
      .map((note) => {
        const subject = subjectText(note);
        return subject === ''
          ? ATTENTION_NAMES[note.kind]
          : `${ATTENTION_NAMES[note.kind]} ${subject}`;
      });
    return texts.length === 0 ? [] : [{ notes: texts, system }];
  });
};

// One System's tile: its lane, its own items, its worst level that calls for
// action, and whether it is asleep.
export type SystemTile = {
  asleep: boolean;
  items: Attention[];
  lane: SystemGlance;
  level: 'alert' | 'warning' | undefined;
};

// The tiles in reading order: Systems with alerts, then warnings, awake before
// asleep, then by name.
export const tileOrder = (
  lanes: readonly SystemGlance[],
  attention: readonly Attention[],
  now: number,
): SystemTile[] =>
  lanes
    .map((lane) => {
      const items = attention.filter((item) => item.system === lane.name);
      const counts = levelCounts(items);
      return { asleep: isAsleep(lane, now), counts, items, lane, level: worstActionLevel(counts) };
    })
    .toSorted(
      (a, b) =>
        Number(b.counts.alert > 0) - Number(a.counts.alert > 0) ||
        Number(b.counts.warning > 0) - Number(a.counts.warning > 0) ||
        Number(a.asleep) - Number(b.asleep) ||
        a.lane.name.localeCompare(b.lane.name),
    )
    .map(({ asleep, items, lane, level }) => ({ asleep, items, lane, level }));

// The mount the Disk meter reads and its percent used: the mount carrying the
// worst open low_disk Condition (its subject is the mount), else the fullest.
// Undefined when the sample lists no disk.
export const diskReading = (
  disks: readonly Disk[],
  items: readonly Attention[],
): { mount: string; percent: number } | undefined => {
  const named = items
    .flatMap((item) => {
      const disk = disks.find(({ mount, totalBytes }) => mount === item.subject && totalBytes > 0);
      return item.kind === 'low_disk' && item.level !== undefined && disk !== undefined
        ? [{ disk, level: item.level, percent: diskUsage(disk).percent }]
        : [];
    })
    .toSorted(
      (a, b) =>
        WORST_FIRST.indexOf(a.level) - WORST_FIRST.indexOf(b.level) || b.percent - a.percent,
    )[0];
  const disk = named?.disk ?? fullestDisk(disks);
  return disk === undefined ? undefined : { mount: disk.mount, percent: diskUsage(disk).percent };
};
