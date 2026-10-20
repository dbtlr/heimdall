import type { HarnessInstall, ConditionKind } from '@heimdall/schema';
import type { SQL } from 'bun';

import { pairedSystems } from '../tokens.ts';

// A Condition that is raised now, with what it is about, when it was raised,
// and its latest reason. The subject is empty for a Condition about the System.
export type OpenCondition = {
  kind: ConditionKind;
  raisedAt: number;
  reason: string;
  subject: string;
};

// One line of a System's Timeline: a Condition raised, with the reason it was
// raised for, or cleared.
export type TimelineEntry =
  | { at: number; condition: ConditionKind; kind: 'raised'; reason: string; subject: string }
  | { at: number; condition: ConditionKind; kind: 'cleared'; subject: string };

// What the Hub derived about one System: when it last heard from it, undefined
// for a paired System it never has, whether it holds a token, its open
// Conditions, its whole Timeline, newest Condition first, and the Harness
// installs from its latest Report that carried them.
export type DerivedSystem = {
  conditions: OpenCondition[];
  harnesses: HarnessInstall[] | undefined;
  lastSeenAt: number | undefined;
  name: string;
  paired: boolean;
  timeline: TimelineEntry[];
};

type ConditionRow = {
  cleared_at: Date | null;
  kind: ConditionKind;
  raised_at: Date;
  raised_reason: string;
  subject: string;
  system: string;
};

type OpenRow = {
  kind: ConditionKind;
  latest_reason: string;
  raised_at: Date;
  subject: string;
  system: string;
};

// A Condition's lines on the Timeline, newest first.
const timelineOf = (row: ConditionRow): TimelineEntry[] => {
  const raised: TimelineEntry = {
    at: row.raised_at.getTime(),
    condition: row.kind,
    kind: 'raised',
    reason: row.raised_reason,
    subject: row.subject,
  };
  return row.cleared_at === null
    ? [raised]
    : [
        {
          at: row.cleared_at.getTime(),
          condition: row.kind,
          kind: 'cleared',
          subject: row.subject,
        },
        raised,
      ];
};

// Every System the Hub holds, paired or not, by name, as the Hub derived it,
// so a test can check derivation without a reader of its own.
export const listSystems = (sql: SQL): Promise<DerivedSystem[]> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const systems: { last_seen_at: Date | null; name: string }[] = await tx`
      SELECT name, last_seen_at FROM systems ORDER BY name
    `;
    const paired = await pairedSystems(tx);
    const open: OpenRow[] = await tx`
      SELECT system, kind, subject, raised_at, latest_reason FROM conditions
      WHERE cleared_at IS NULL
      ORDER BY raised_at, id
    `;
    // Latest by arrival: ids are assigned under the System's row lock, so
    // they order Conditions even when the Hub clock steps back.
    const conditions: ConditionRow[] = await tx`
      SELECT system, kind, subject, raised_at, raised_reason, cleared_at
      FROM conditions
      ORDER BY id DESC
    `;
    const installed: { installs: HarnessInstall[]; system: string }[] = await tx`
      SELECT system, installs FROM harness_installs
    `;
    return systems.map((row) => ({
      conditions: open
        .filter((c) => c.system === row.name)
        .map((c) => ({
          kind: c.kind,
          raisedAt: c.raised_at.getTime(),
          reason: c.latest_reason,
          subject: c.subject,
        })),
      harnesses: installed.find((h) => h.system === row.name)?.installs,
      lastSeenAt: row.last_seen_at?.getTime(),
      name: row.name,
      paired: paired.has(row.name),
      timeline: conditions.filter((c) => c.system === row.name).flatMap(timelineOf),
    }));
  });
