// What one opened Condition's page says, as plain values the component only
// renders: the title and level, the number it leads with, the chart of the
// reading it rests on against the limits the Hub stores now, the levels it
// went through, and what to do about it.

import type { ConditionLevel, ConditionLimitSet, ConditionTransition } from '@heimdall/schema';

import type {
  ConditionDetail,
  ConditionSeries,
  PendingPackage,
} from '../server/condition-detail-types.ts';
import { ATTENTION_NAMES, evidenceNote, evidenceWords, nextSteps } from './attention.ts';
import type { NextStep } from './attention.ts';
import { conditionSubject, transitionLabel } from './conditions.ts';
import { diskGrowth } from './disk-growth.ts';
import type { Phrase } from './phrase.ts';
import { formatSpan } from './time.ts';
import type { Window } from './time.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The number a page leads with, its unit in small type after it, and the words
// that finish the sentence.
export type HeroView = { text: Phrase; unit: string; value: string };

// A dashed line across the chart at a limit the Hub judges by now.
export type ChartLine = { label: string; level: ConditionLevel; value: number };

// A reading; null where the bucket had none, which breaks the line.
export type ChartPoint = { t: number; value: number | null };

export type ChartView = {
  // What the chart says about itself: the series and window on the left, the
  // chart's scale and the lines on the right, and for load Conditions the rule
  // that turns the limit into a level.
  captions: { left: string; right: string; rule: string | undefined };
  // The plotted range on the value axis.
  domain: [number, number];
  label: string;
  lines: ChartLine[];
  points: ChartPoint[];
  window: Window;
};

export type HistoryRow = {
  at: number;
  backfilled: boolean;
  label: string;
  // The level the row reached, or `cleared`.
  level: ConditionLevel | 'cleared';
  // The Hub's own words for the transition.
  reason: string | undefined;
};

// One package of a pending_update Condition's source.
export type PackageRow = {
  name: string;
  // How long a security update has waited since the Hub confirmed it.
  pending: string | undefined;
  security: 'yes' | 'no' | 'unknown';
  versions: string;
};

export type ConditionDetailView = {
  chart: ChartView | undefined;
  cleared: boolean;
  evidenceNote: Phrase | undefined;
  hero: HeroView;
  history: HistoryRow[];
  level: ConditionLevel;
  // Undefined once cleared.
  nextStep: { clears: string | undefined; steps: NextStep[] } | undefined;
  // The packages a pending_update Condition's source has pending, security
  // updates first; empty when none is; undefined for any other Condition.
  packages: PackageRow[] | undefined;
  // How the reading is taken and how fresh it is; '' when there is nothing to say.
  provenance: string;
  rate: { estimate: true; text: string } | undefined;
  system: string;
  title: string;
};

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

// "7 days" or "24 h": a length of time.
const spanWords = (span: number) =>
  span >= 2 * DAY_MS
    ? `${String(Math.round(span / DAY_MS))} days`
    : `${String(Math.round(span / HOUR_MS))} h`;

// The length of the chart's window.
const windowWords = ({ from, to }: Window) => spanWords(to - from);

// "38 GiB", or "3.2 GiB" below ten.
const gib = (bytes: number) => {
  const value = bytes / GIB;
  return `${value >= 10 ? String(Math.round(value)) : value.toFixed(1)} GiB`;
};

const cores = (count: number) => (count > 1 ? `${String(count)} cores` : `${String(count)} core`);

// How long the Condition was open, in a big number and a small unit.
const duration = (ms: number): { unit: string; value: string } => {
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) {
    return { unit: days === 1 ? 'day' : 'days', value: String(days) };
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (hours >= 1) {
    return { unit: minutes === 0 ? 'h' : `h ${String(minutes)} min`, value: String(hours) };
  }
  return { unit: 'min', value: minutes === 0 ? '<1' : String(minutes) };
};

const updatedAgo = (checkedAt: number | undefined, now: number) => {
  if (checkedAt === undefined) {
    return '';
  }
  const age = now - checkedAt;
  return age < MINUTE_MS ? 'Updated just now.' : `Updated ${formatSpan(age)} ago.`;
};

// The reading's value for a plotted domain, rounded out to steps of 5 and kept
// within 0 to 100.
const percentDomain = (values: readonly number[]): [number, number] => [
  Math.max(0, Math.floor((Math.min(...values) - 5) / 5) * 5),
  Math.min(100, Math.ceil((Math.max(...values) + 5) / 5) * 5),
];

const present = (points: readonly ChartPoint[]) =>
  points.flatMap((point) => (point.value === null ? [] : [point.value]));

// Readings further apart than this are not one continuous line.
const GAP_MS = 15 * MINUTE_MS;

// Whether a reading has no reading beside it, so a line cannot show it and the
// chart draws it as a dot instead.
export const isLone = (points: readonly ChartPoint[], index: number): boolean =>
  points[index]?.value !== null &&
  points[index - 1]?.value == null &&
  points[index + 1]?.value == null;

// The points with an empty one between any two more than GAP_MS apart, so the
// line breaks there instead of crossing the time nothing was read.
export const withGaps = (points: readonly ChartPoint[]): ChartPoint[] =>
  points.flatMap((point, index) => {
    const before = points[index - 1];
    return before !== undefined && point.t - before.t > GAP_MS
      ? [{ t: (before.t + point.t) / 2, value: null }, point]
      : [point];
  });

// What a chart of one series is made of, before it is set against limits.
type Reading = {
  left: string;
  points: ChartPoint[];
  provenance: string;
};

const readingOf = (detail: ConditionDetail, series: ConditionSeries): Reading => {
  switch (series.kind) {
    case 'disk': {
      return {
        left: 'Disk used',
        points: series.points.map(({ t, totalBytes, usedBytes }) => ({
          t,
          value: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : null,
        })),
        provenance: 'Used space is the highest reading in each 5 minutes.',
      };
    }
    case 'percent': {
      const memory = detail.kind === 'high_memory';
      return {
        left: memory ? 'Memory used' : 'CPU busy',
        points: series.points.map(({ percent, t }) => ({ t, value: percent })),
        provenance: memory
          ? 'Memory used is averaged over each 5 minutes.'
          : 'CPU busy is averaged over each 5 minutes.',
      };
    }
    case 'cores': {
      return {
        left: `${conditionSubject(detail)} CPU`,
        points: series.points.map(({ cores: used, t }) => ({ t, value: used })),
        provenance: 'Cores are the highest reading in each 5 minutes.',
      };
    }
    default: {
      const _exhaustive: never = series;
      return _exhaustive;
    }
  }
};

// The lines the Hub's stored limits draw for this kind, with the rule behind
// them for the load kinds. Empty when the Hub has stored no limits.
const limitLines = (
  detail: ConditionDetail,
  limits: ConditionLimitSet | undefined,
): { lines: ChartLine[]; rule: string | undefined } => {
  if (limits === undefined) {
    return { lines: [], rule: undefined };
  }
  const { level } = detail;
  switch (detail.kind) {
    case 'low_disk': {
      const { alert, note, warning } = limits.disk;
      return {
        lines: [
          { label: `${String(note)}%`, level: 'note', value: note },
          { label: `${String(warning)}%`, level: 'warning', value: warning },
          { label: `${String(alert)}%`, level: 'alert', value: alert },
        ],
        rule: undefined,
      };
    }
    case 'high_cpu': {
      const { noteMinutes, noteWindowMinutes, percent, warningMinutes, warningWindowMinutes } =
        limits.cpu;
      return {
        lines: [{ label: `${String(percent)}%`, level, value: percent }],
        rule: `above ${String(percent)}% for ${String(noteMinutes)} of ${String(noteWindowMinutes)} min is a note, ${String(warningMinutes)} of ${String(warningWindowMinutes)} a warning`,
      };
    }
    case 'high_memory': {
      const { percent, warningMinutes, warningWindowMinutes } = limits.memory;
      // macOS judges kernel memory pressure, so no usage limit applies.
      if (detail.platform === 'darwin') {
        return {
          lines: [],
          rule: `memory pressure for ${String(warningMinutes)} of ${String(warningWindowMinutes)} min is a warning`,
        };
      }
      return {
        lines: [{ label: `${String(percent)}%`, level, value: percent }],
        rule: `above ${String(percent)}% for ${String(warningMinutes)} of ${String(warningWindowMinutes)} min is a warning`,
      };
    }
    case 'hot_process': {
      const {
        cores: limit,
        noteMinutes,
        noteWindowMinutes,
        warningMinutes,
        warningWindowMinutes,
      } = limits.process;
      return {
        lines: [{ label: cores(limit), level, value: limit }],
        rule: `above ${cores(limit)} for ${String(noteMinutes)} of ${String(noteWindowMinutes)} min is a note, ${String(warningMinutes)} of ${String(warningWindowMinutes)} a warning`,
      };
    }
    default: {
      return { lines: [], rule: undefined };
    }
  }
};

const chartOf = (
  detail: ConditionDetail,
  reading: Reading,
  values: readonly number[],
): ChartView => {
  const { lines, rule } = limitLines(detail, detail.limits);
  const window = { from: detail.from, to: detail.to };
  const isCores = detail.kind === 'hot_process';
  const lineValues = lines.map((line) => line.value);
  const domain: [number, number] = isCores
    ? [0, Math.ceil(Math.max(...values, ...lineValues) * 1.2 * 10) / 10]
    : percentDomain([...values, ...lineValues]);
  // The caption states the chart's scale, not the readings' range.
  const range = isCores
    ? `0 to ${String(domain[1])} cores`
    : `${String(domain[0])} to ${String(domain[1])}%`;
  let right = detail.limits === undefined ? `${range}; limits unknown` : range;
  if (lines.length > 0) {
    right =
      detail.kind === 'low_disk'
        ? `${range}, lines at ${lines.map((line) => String(line.value)).join(', ')}`
        : `${range}, ${isCores ? 'limit' : 'line at'} ${lines.map((line) => line.label).join(', ')}`;
  }
  return {
    captions: { left: `${reading.left}, last ${windowWords(window)}`, right, rule },
    domain,
    label: `${reading.left} over the last ${windowWords(window)}`,
    lines,
    points: withGaps(reading.points),
    window,
  };
};

type Leading = {
  chart: ChartView | undefined;
  hero: HeroView | undefined;
  provenance: string;
  rate: ConditionDetailView['rate'];
};

const NOTHING: Leading = { chart: undefined, hero: undefined, provenance: '', rate: undefined };

// "used. 38 GiB free of 431 GiB on /."; after a clearing, "used when it cleared."
const diskHeroText = (
  usedBytes: number,
  totalBytes: number,
  mount: string,
  cleared: boolean,
): Phrase => [
  `${cleared ? 'used when it cleared' : 'used'}. ${gib(totalBytes - usedBytes)} free of ${gib(totalBytes)} on ${mount}.`,
];

const rateOf = (detail: ConditionDetail): ConditionDetailView['rate'] => {
  const growth =
    detail.series?.kind === 'disk' && detail.clearedAt === undefined
      ? diskGrowth(detail.series.points)
      : undefined;
  const readings = detail.series?.kind === 'disk' ? detail.series.points : [];
  const first = readings[0];
  const last = readings.at(-1);
  if (
    growth === undefined ||
    first === undefined ||
    last === undefined ||
    growth.bytesPerDay < MIB ||
    growth.daysUntilFull === undefined
  ) {
    return undefined;
  }
  const perDay =
    growth.bytesPerDay >= GIB
      ? gib(growth.bytesPerDay)
      : `${String(Math.round(growth.bytesPerDay / MIB))} MiB`;
  const days = Math.round(growth.daysUntilFull);
  let fills = `in about ${plural(days, 'day', 'days')}`;
  if (growth.daysUntilFull < 1) {
    fills = 'in under a day';
  } else if (growth.daysUntilFull >= 365) {
    fills = 'in over a year';
  }
  return {
    estimate: true,
    text: `+${perDay} a day over the last ${spanWords(last.t - first.t)}. At that rate it is full ${fills}.`,
  };
};

// The hero, chart, and rate of a kind whose reading is drawn; NOTHING when it
// has no reading to lead with, so the page leads with how long it has been open.
const leadingOf = (detail: ConditionDetail): Leading => {
  const { series } = detail;
  const cleared = detail.clearedAt !== undefined;
  if (series === undefined) {
    return detail.kind === 'low_disk' ? diskFallback(detail) : NOTHING;
  }
  const reading = readingOf(detail, series);
  const values = present(reading.points);
  const latest = reading.points.findLast((point) => point.value !== null)?.value ?? undefined;
  const chart = values.length >= 2 ? chartOf(detail, reading, values) : undefined;
  const lead = { chart, provenance: reading.provenance, rate: rateOf(detail) };
  if (series.kind === 'disk') {
    // No newest reading with a size leads with the Vitals instead.
    const newest = series.points.at(-1);
    if (newest === undefined || newest.totalBytes <= 0) {
      return { ...lead, hero: diskFallback(detail).hero };
    }
    return {
      ...lead,
      hero: {
        text: diskHeroText(newest.usedBytes, newest.totalBytes, detail.subject, cleared),
        unit: '%',
        value: String(Math.round((newest.usedBytes / newest.totalBytes) * 100)),
      },
    };
  }
  if (latest === undefined) {
    return NOTHING;
  }
  const reason = `${cleared ? 'when it cleared' : 'at the latest reading'}. ${detail.latestReason}`;
  if (series.kind === 'cores') {
    const unit = latest < 1 ? 'of a core' : 'cores';
    return { ...lead, hero: { text: [reason], unit, value: latest.toFixed(2) } };
  }
  const what = detail.kind === 'high_memory' ? 'in use' : 'busy';
  return {
    ...lead,
    hero: { text: [`${what} ${reason}`], unit: '%', value: String(Math.round(latest)) },
  };
};

// A mount whose readings did not come back, or came back without a size,
// still leads with the share used the Hub's latest Vitals show.
const diskFallback = (detail: ConditionDetail): Leading => {
  const disk = detail.attention?.kind === 'low_disk' ? detail.attention.disk : undefined;
  if (disk === undefined || disk.totalBytes <= 0) {
    return NOTHING;
  }
  return {
    ...NOTHING,
    hero: {
      text: diskHeroText(disk.usedBytes, disk.totalBytes, detail.subject, false),
      unit: '%',
      value: String(Math.round((disk.usedBytes / disk.totalBytes) * 100)),
    },
  };
};

// How long the Condition has been open, or was before it cleared, with what the
// Hub observed.
const openHero = (detail: ConditionDetail, now: number): HeroView => {
  const cleared = detail.clearedAt !== undefined;
  const { unit, value } = duration(Math.max(0, (detail.clearedAt ?? now) - detail.raisedAt));
  const observed: Phrase =
    detail.attention === undefined
      ? [detail.latestReason]
      : evidenceWords(detail.attention, now).observed;
  return {
    text: [cleared ? 'open before it cleared. ' : 'open. ', ...observed],
    unit,
    value,
  };
};

// The row for one transition, with the Hub's own words beneath. No row names a
// limit: the limits in force then may differ from the ones stored now.
const historyRow = (transition: ConditionTransition): HistoryRow => ({
  at: transition.at,
  backfilled: transition.backfilled,
  label: transitionLabel(transition),
  level: transition.kind === 'cleared' ? 'cleared' : transition.level,
  reason: transition.reason,
});

// What a disk's limits say about when it clears. The Hub eases a level once
// used falls below its limit less the margin, and clears the Condition only
// below the note limit less the margin; undefined for kinds with no such margin.
const clearsBelow = (detail: ConditionDetail): string | undefined => {
  const disk = detail.kind === 'low_disk' ? detail.limits?.disk : undefined;
  if (disk === undefined) {
    return undefined;
  }
  const clears = String(disk.note - disk.hysteresis);
  if (detail.level === 'note') {
    return `It clears below ${clears}%.`;
  }
  return `The ${detail.level} eases below ${String(disk[detail.level] - disk.hysteresis)}%, and the Condition clears below ${clears}%.`;
};

// A package the Hub holds a security age for is a security update, whatever the
// latest observation reports; otherwise the latest report stands.
const securityWord = ({ security, securitySince }: PendingPackage) => {
  if (securitySince !== null || security === true) {
    return 'yes';
  }
  return security === null ? 'unknown' : 'no';
};

const packageRow = (item: PendingPackage, now: number): PackageRow => ({
  name: item.name,
  pending: item.securitySince === null ? undefined : formatSpan(now - item.securitySince),
  security: securityWord(item),
  versions: `${item.installed ?? 'unknown'} → ${item.available ?? 'unknown'}`,
});

// The page for one Condition occurrence, at `now` (epoch milliseconds).
export const conditionDetailView = (detail: ConditionDetail, now: number): ConditionDetailView => {
  const { attention } = detail;
  const leading = leadingOf(detail);
  const subject = conditionSubject(detail);
  const kindName = ATTENTION_NAMES[detail.kind];
  return {
    chart: leading.chart,
    cleared: detail.clearedAt !== undefined,
    evidenceNote: attention === undefined ? undefined : evidenceNote(attention, now),
    hero: leading.hero ?? openHero(detail, now),
    history: detail.transitions.map(historyRow),
    level: detail.level,
    nextStep:
      attention === undefined
        ? undefined
        : { clears: clearsBelow(detail), steps: nextSteps(attention).steps },
    packages: detail.packages?.map((item) => packageRow(item, now)),
    provenance: [leading.provenance, updatedAgo(attention?.checkedAt, now)]
      .filter((part) => part !== '')
      .join(' '),
    rate: leading.rate,
    system: detail.system,
    title: subject === '' ? kindName : `${kindName} ${subject}`,
  };
};
