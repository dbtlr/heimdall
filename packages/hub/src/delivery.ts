import { CONDITION_KIND_NAMES, conditionSubject } from '@heimdall/schema';
import type { ConditionKind, ConditionLevel } from '@heimdall/schema';
import type { SQL } from 'bun';

// How long an identity stays below alert before its delivery closes.
export const RECOVERED_AFTER_MS = 10 * 60_000;

// One message to the channel: a push is high priority, a recovered message low.
export type Message = {
  click: string;
  message: string;
  priority: 'high' | 'low';
  title: string;
};

export type Send = (message: Message) => Promise<void>;

type Identity = { kind: ConditionKind; subject: string; system: string };

// An identity at alert with no open delivery: its open Condition, the reason
// the Hub gives now, and when it reached alert.
type DuePush = Identity & { alertSince: Date; id: string; reason: string };

// An open delivery whose identity has stayed below alert long enough: the
// level it is at now, none when cleared, its latest occurrence, and how many
// times it reached alert since the delivery opened.
type DueRecovery = Identity & {
  delivery: string;
  latest: string;
  level: ConditionLevel | null;
  times: number;
};

// Transitions into alert: raised at alert, or stepped up to it.
const REACHED_ALERT = `t.level = 'alert' AND t.action <> 'cleared'`;

const duePushes = (sql: SQL): Promise<DuePush[]> => sql`
  SELECT c.id::text AS id, c.system, c.kind, c.subject, c.latest_reason AS reason,
    COALESCE((
      SELECT max(t.at) FROM condition_transitions t
      WHERE t.condition = c.id AND ${sql.unsafe(REACHED_ALERT)}
    ), c.raised_at) AS "alertSince"
  FROM conditions c
  JOIN paired_systems p ON p.system = c.system
  WHERE c.cleared_at IS NULL AND c.level = 'alert'
    AND NOT EXISTS (
      SELECT 1 FROM deliveries d
      WHERE (d.system, d.kind, d.subject) = (c.system, c.kind, c.subject)
        AND d.recovered_at IS NULL
    )
  ORDER BY c.system, c.kind, c.subject
`;

// An identity is below alert from the latest time one of its occurrences left
// alert, by clearing at alert or stepping down from it.
const dueRecoveries = (sql: SQL, now: number): Promise<DueRecovery[]> => sql`
  SELECT d.id::text AS delivery, d.system, d.kind, d.subject, open.level,
    (
      SELECT max(c.id)::text FROM conditions c
      WHERE (c.system, c.kind, c.subject) = (d.system, d.kind, d.subject)
    ) AS latest,
    (
      SELECT count(*)::int FROM condition_transitions t
      JOIN conditions c ON c.id = t.condition
      WHERE (c.system, c.kind, c.subject) = (d.system, d.kind, d.subject)
        AND ${sql.unsafe(REACHED_ALERT)} AND t.at >= d.alert_since
    ) AS times
  FROM deliveries d
  JOIN paired_systems p ON p.system = d.system
  LEFT JOIN conditions open
    ON (open.system, open.kind, open.subject) = (d.system, d.kind, d.subject)
   AND open.cleared_at IS NULL
  WHERE d.recovered_at IS NULL
    AND open.level IS DISTINCT FROM 'alert'
    AND COALESCE((
      SELECT max(t.at) FROM condition_transitions t
      JOIN conditions c ON c.id = t.condition
      WHERE (c.system, c.kind, c.subject) = (d.system, d.kind, d.subject)
        AND ((t.action = 'cleared' AND t.level = 'alert')
          OR (t.action = 'level_changed' AND t.previous_level = 'alert'))
    ), d.pushed_at) <= ${new Date(now - RECOVERED_AFTER_MS)}
  ORDER BY d.system, d.kind, d.subject
`;

const titleOf = ({ kind, subject, system }: Identity) => {
  const label = conditionSubject({ kind, subject });
  return `${CONDITION_KIND_NAMES[kind]} on ${system}${label === '' ? '' : `: ${label}`}`;
};

// A whole number of minutes, as hours and minutes.
const minutesText = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'under a minute';
  }
  const hours = Math.floor(minutes / 60);
  return [
    hours > 0 ? `${String(hours)} h` : '',
    minutes % 60 > 0 ? `${String(minutes % 60)} min` : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
};

const timesText = (times: number) => {
  if (times <= 1) {
    return 'once';
  }
  return times === 2 ? 'twice' : `${String(times)} times`;
};

const conditionPage = (dashboard: URL, system: string, id: string) =>
  new URL(`systems/${encodeURIComponent(system)}/conditions/${id}`, dashboard).href;

// One message for everything due at one priority. A single Condition's opens
// its page; several open the Fleet page and list one line each.
const batch = (
  items: readonly { body: string; click: string; title: string }[],
  { dashboard, noun, priority }: { dashboard: URL; noun: string; priority: Message['priority'] },
): Message => {
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    return { click: only.click, message: only.body, priority, title: only.title };
  }
  return {
    click: dashboard.href,
    message: items.map((item) => `${item.title}. ${item.body}`).join('\n'),
    priority,
    title: `${String(items.length)} ${noun}`,
  };
};

const pushMessage = (pushes: readonly DuePush[], now: number, dashboard: URL): Message =>
  batch(
    pushes.map((push) => ({
      body: `${push.reason} At alert for ${minutesText(now - push.alertSince.getTime())}.`,
      click: conditionPage(dashboard, push.system, push.id),
      title: titleOf(push),
    })),
    { dashboard, noun: 'alerts', priority: 'high' },
  );

// A lone recovered message says so in its title; in a batch, the title does.
const recoveredMessage = (recoveries: readonly DueRecovery[], dashboard: URL): Message => {
  const prefix = recoveries.length === 1 ? 'Recovered: ' : '';
  return batch(
    recoveries.map((recovery) => ({
      body: `${recovery.level === null ? 'Cleared' : `Now at ${recovery.level}`}. Reached alert ${timesText(recovery.times)}.`,
      click: conditionPage(dashboard, recovery.system, recovery.latest),
      title: `${prefix}${titleOf(recovery)}`,
    })),
    { dashboard, noun: 'recovered', priority: 'low' },
  );
};

// One delivery pass (ADR-0020): compares the Conditions stored now with the
// deliveries recorded, sends what has come due, and records it once sent. A
// send that fails records nothing, so the next pass sends what is true then:
// an identity that left alert in between is never pushed, and one still at
// alert is pushed with how long it has been there. Only paired Systems are
// delivered. Throws when a send fails, after trying both priorities.
export const deliverAlerts = async (
  sql: SQL,
  { dashboard, now, send }: { dashboard: URL; now: number; send: Send },
): Promise<void> => {
  const pushes = await duePushes(sql);
  const recoveries = await dueRecoveries(sql, now);
  const failures: unknown[] = [];
  if (pushes.length > 0) {
    try {
      await send(pushMessage(pushes, now, dashboard));
      for (const push of pushes) {
        // oxlint-disable-next-line no-await-in-loop -- a pass delivers a handful at most.
        await sql`
          INSERT INTO deliveries (system, kind, subject, alert_since, pushed_at)
          VALUES (${push.system}, ${push.kind}, ${push.subject}, ${push.alertSince}, ${new Date(now)})
          ON CONFLICT (system, kind, subject) WHERE recovered_at IS NULL DO NOTHING
        `;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (recoveries.length > 0) {
    try {
      await send(recoveredMessage(recoveries, dashboard));
      for (const recovery of recoveries) {
        // oxlint-disable-next-line no-await-in-loop -- a pass delivers a handful at most.
        await sql`
          UPDATE deliveries SET recovered_at = ${new Date(now)} WHERE id = ${recovery.delivery}
        `;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  const [failure] = failures;
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map(String).join('; '));
  }
  if (failure !== undefined) {
    throw failure;
  }
};
