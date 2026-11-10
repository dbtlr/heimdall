// What Home says before any detail: the verdict sentence and the facts behind
// it, the item that needs the operator most, and the fleet's figures. Health is
// the worst open level, and notes never make the fleet look unhealthy
// (ADR-0017).

import type { Attention } from '../server/attention-types.ts';
import type { FleetGlance } from '../server/fleet-overview-types.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { TileGlance } from '../server/home-types.ts';
import { ATTENTION_NAMES, subjectText } from './attention.ts';
import { deliveryFailingShown, fleetAttention, isAsleep } from './fleet.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { formatSpan, silenceLeft } from './time.ts';
import { emptyFleetText } from './unpaired.ts';

// An open Condition at a level that asks for action.
export type Actionable = Attention & { level: 'alert' | 'warning' };

const isActionable = (item: Attention): item is Actionable =>
  item.level === 'alert' || item.level === 'warning';

// The open Conditions on paired Systems that need the operator, alerts before
// warnings, then newest first: `lead` is the one Home shows with its evidence,
// `rest` the others. Notes can wait in their own list, and evidence the Hub
// holds no Condition for stays on its System's tile and page, so neither is here.
export const pickAttention = (
  items: readonly Attention[],
): { lead: Actionable | undefined; rest: Actionable[] } => {
  const [lead, ...rest] = items
    .filter((item): item is Actionable => isActionable(item) && !item.unpaired)
    .toSorted(
      (a, b) =>
        Number(b.level === 'alert') - Number(a.level === 'alert') ||
        b.firstDetected - a.firstDetected ||
        a.system.localeCompare(b.system) ||
        a.kind.localeCompare(b.kind) ||
        a.subject.localeCompare(b.subject),
    );
  return { lead, rest };
};

// "Low disk /data on server-1": an item's Condition, subject, and System.
export const itemTitle = (item: Attention): string => {
  const subject = subjectText(item);
  return `${ATTENTION_NAMES[item.kind]}${subject === '' ? '' : ` ${subject}`} on ${item.system}`;
};

// The verdict card's edge: the worst open level, healthy, or no System to judge.
export type VerdictLevel = 'alert' | 'warning' | 'healthy' | 'empty';

export type HomeVerdict = { level: VerdictLevel; sentence: string; support: Phrase };

type VerdictInput = Pick<
  FleetGlance<TileGlance>,
  'attention' | 'deliveryFailingSince' | 'lanes' | 'now'
>;

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${String(n)} ${many}`);

// The sentence Home opens with, worst level first: one alert names itself,
// several are counted; else the Systems with warnings are counted; else the
// fleet is healthy, whatever notes are open.
const sentenceOf = (
  { alert, warningSystems }: { alert: number; warningSystems: number },
  lead: Attention | undefined,
): string => {
  if (alert === 1 && lead !== undefined) {
    return lead.kind === 'service_down'
      ? `${lead.subject} is down on ${lead.system}.`
      : `${ATTENTION_NAMES[lead.kind]} on ${lead.system}.`;
  }
  if (alert > 1) {
    return `${String(alert)} things need you now.`;
  }
  if (warningSystems > 0) {
    return `${count(warningSystems, 'One System needs', 'Systems need')} you this week.`;
  }
  return 'Everything is healthy.';
};

// What the worst item is and how long it has been open, beside a sentence that
// already names it or one that does not.
const leadWords = (lead: Attention, named: boolean, alone: boolean, now: number): string => {
  const open = formatSpan(Math.max(0, now - lead.firstDetected));
  if (named) {
    return lead.kind === 'service_down' ? `Down for ${open}.` : `Open for ${open}.`;
  }
  return alone
    ? `${itemTitle(lead)} has been open for ${open}.`
    : `The newest is ${itemTitle(lead)}, open for ${open}.`;
};

// Whether any Service is down, or for a healthy fleet that every System
// reports and every Service is up, when both hold.
const downWords = (down: number, leadIsDown: boolean, allClear: boolean): string | undefined => {
  if (leadIsDown) {
    const others = down - 1;
    return others === 0
      ? undefined
      : `${count(others, 'One other Service is', 'other Services are')} down.`;
  }
  if (down > 0) {
    return `${count(down, 'One Service is', 'Services are')} down.`;
  }
  return allClear ? 'Every System reports and every Service is up.' : 'Nothing is down.';
};

const asleepWords = (asleep: readonly { name: string }[], systems: number): string | undefined => {
  const [only] = asleep;
  if (only === undefined) {
    return undefined;
  }
  if (asleep.length === systems && systems > 1) {
    return 'Every System is asleep.';
  }
  return asleep.length === 1
    ? `${only.name} is asleep.`
    : `${String(asleep.length)} Systems are asleep.`;
};

const silenceWords = (lanes: VerdictInput['lanes'], now: number): string | undefined => {
  const silenced = lanes.filter(
    (lane) => lane.silencedUntil !== undefined && lane.silencedUntil > now,
  );
  const [only] = silenced;
  if (only?.silencedUntil === undefined) {
    return undefined;
  }
  return silenced.length === 1
    ? `Alerts on ${only.name} are silenced for ${silenceLeft(now, only.silencedUntil)}.`
    : `Alerts on ${String(silenced.length)} Systems are silenced.`;
};

// The parts joined into one line, a space between each.
const joined = (parts: readonly (Phrase | string | undefined)[]): Phrase =>
  parts
    .filter((part) => part !== undefined)
    .flatMap((part, index) => (index === 0 ? [part] : [' ', part]))
    .flat();

// Home's verdict on the paired Systems: the sentence, the level its card's
// edge takes, and a supporting line of facts the glance already holds: the
// worst item and how long it has been open, whether anything is down, Systems
// asleep, a silence, failing alert delivery (ADR-0020), and notes that can wait.
// With no System to judge, it says so, and still states failing delivery.
export const homeVerdict = (glance: VerdictInput): HomeVerdict => {
  const { attention, lanes, now } = glance;
  const failingSince = deliveryFailingShown(glance);
  const delivery =
    failingSince === undefined
      ? undefined
      : ['Alert delivery has failed since ', whenAt(failingSince, now), '.'];
  const empty = emptyFleetText(lanes);
  if (empty !== undefined) {
    return { level: 'empty', sentence: empty.text, support: joined([delivery]) };
  }
  const { counts, notes } = fleetAttention(attention);
  const { lead } = pickAttention(attention);
  const paired = attention.filter((item) => !item.unpaired);
  const warningSystems = new Set(
    paired.filter((item) => item.level === 'warning').map(({ system }) => system),
  ).size;
  const sentence = sentenceOf({ alert: counts.alert, warningSystems }, lead);
  const named = counts.alert === 1;
  const asleep = lanes.filter((lane) => isAsleep(lane, now));
  const allClear =
    lead === undefined &&
    lanes.every(
      ({ lastSeenAt }) => lastSeenAt !== undefined && now - lastSeenAt <= QUIET_AFTER_MS,
    ) &&
    lanes.every(({ services }) => services.up === services.total);
  return {
    level: lead?.level ?? 'healthy',
    sentence,
    support: joined([
      lead === undefined ? undefined : leadWords(lead, named, counts[lead.level] === 1, now),
      downWords(
        paired.filter((item) => item.kind === 'service_down' && item.level !== undefined).length,
        named && lead?.kind === 'service_down',
        allClear,
      ),
      asleepWords(asleep, lanes.length),
      silenceWords(lanes, now),
      delivery,
      notes.length === 0 ? undefined : `${count(notes.length, 'One note', 'notes')} can wait.`,
    ]),
  };
};

// The figures beside the verdict: the Systems heard from within the quiet
// limit, and the Services up, each out of all the paired Systems have.
export const homeFigures = (lanes: readonly TileGlance[], now: number) => ({
  awake: lanes.filter(
    ({ lastSeenAt }) => lastSeenAt !== undefined && now - lastSeenAt <= QUIET_AFTER_MS,
  ).length,
  services: lanes.reduce((sum, { services }) => sum + services.total, 0),
  servicesUp: lanes.reduce((sum, { services }) => sum + services.up, 0),
  systems: lanes.length,
});
