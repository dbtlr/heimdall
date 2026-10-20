import { CONDITION_KIND_NAMES, conditionSubject } from '@heimdall/schema';
import type { ConditionKind, ConditionLevel } from '@heimdall/schema';
import type { SQL } from 'bun';

import { describeError } from './errors.ts';

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

// An open delivery that has closed: the first time since it opened that its
// identity left alert and stayed below it for 10 minutes. It carries the level
// the identity is at now, none when cleared; the occurrence it closed on; and
// how many times it reached alert before it closed.
type DueRecovery = Identity & {
  delivery: string;
  latest: string;
  level: ConditionLevel | null;
  times: number;
};

// Transitions into alert: raised at alert, or stepped up to it.
const REACHED_ALERT = `level = 'alert' AND action <> 'cleared'`;
// Transitions out of alert: cleared at alert, or stepped down from it.
const LEFT_ALERT = `((action = 'cleared' AND level = 'alert') OR (action = 'level_changed' AND previous_level = 'alert'))`;

// Each identity's transitions, with the identity on every row.
const IDENTITY_TRANSITIONS = `
  SELECT t.id, t.action, t.level, t.previous_level, t.at, t.condition, c.system, c.kind, c.subject
  FROM condition_transitions t JOIN conditions c ON c.id = t.condition
`;

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
        AND d.closed_at IS NULL
    )
  ORDER BY c.system, c.kind, c.subject
`;

// Closing is read from the history, not only from the present, so a delivery
// that closed while delivery was held closes even if its identity is back at
// alert now. A return to alert is a later transition, by id, so a wall clock
// stepped back cannot hide one.
const dueRecoveries = (sql: SQL, now: number): Promise<DueRecovery[]> => sql`
  WITH identity_transitions AS NOT MATERIALIZED (${sql.unsafe(IDENTITY_TRANSITIONS)})
  SELECT d.id::text AS delivery, d.system, d.kind, d.subject,
    open.level,
    closing.condition::text AS latest,
    (
      SELECT count(*)::int FROM identity_transitions t
      WHERE (t.system, t.kind, t.subject) = (d.system, d.kind, d.subject)
        AND ${sql.unsafe(REACHED_ALERT)} AND t.at >= d.alert_since AND t.at <= closing.at
    ) AS times
  FROM deliveries d
  LEFT JOIN conditions open
    ON (open.system, open.kind, open.subject) = (d.system, d.kind, d.subject)
   AND open.cleared_at IS NULL
  CROSS JOIN LATERAL (
    SELECT t.id, t.at, t.condition
    FROM identity_transitions t
    WHERE (t.system, t.kind, t.subject) = (d.system, d.kind, d.subject)
      AND ${sql.unsafe(LEFT_ALERT)}
      AND t.at >= d.alert_since
      AND t.at <= ${new Date(now - RECOVERED_AFTER_MS)}
      AND NOT EXISTS (
        SELECT 1 FROM identity_transitions back
        WHERE (back.system, back.kind, back.subject) = (d.system, d.kind, d.subject)
          AND back.level = 'alert' AND back.action <> 'cleared'
          AND back.id > t.id
          AND back.at <= t.at + make_interval(secs => ${RECOVERED_AFTER_MS / 1000})
      )
    ORDER BY t.id
    LIMIT 1
  ) closing
  WHERE d.closed_at IS NULL
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

// The most lines a batched message lists; the rest are counted. ntfy turns a
// long message into an attachment, or refuses it.
const MAX_LINES = 10;

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
    message: [
      ...items.slice(0, MAX_LINES).map((item) => `${item.title}. ${item.body}`),
      ...(items.length > MAX_LINES ? [`And ${String(items.length - MAX_LINES)} more.`] : []),
    ].join('\n'),
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

// Where a closed delivery's identity stands now.
const standing = (level: ConditionLevel | null) => {
  if (level === null) {
    return 'Cleared';
  }
  return level === 'alert' ? 'Below alert for 10 minutes, now back at alert' : `Now at ${level}`;
};

// A lone recovered message says so in its title; in a batch, the title does.
const recoveredMessage = (recoveries: readonly DueRecovery[], dashboard: URL): Message => {
  const prefix = recoveries.length === 1 ? 'Recovered: ' : '';
  return batch(
    recoveries.map((recovery) => ({
      body: `${standing(recovery.level)}. Reached alert ${timesText(recovery.times)}.`,
      click: conditionPage(dashboard, recovery.system, recovery.latest),
      title: `${prefix}${titleOf(recovery)}`,
    })),
    { dashboard, noun: 'recovered', priority: 'low' },
  );
};

// Sends `message`, then records what it covered in one transaction. A failed
// send records nothing and answers the error, so the pass can go on.
const sendAndRecord = async (
  sql: SQL,
  send: Send,
  message: Message,
  record: (tx: SQL) => Promise<void>,
): Promise<unknown> => {
  try {
    await send(message);
    await sql.begin(record);
    return undefined;
  } catch (error) {
    return error;
  }
};

// One delivery pass (ADR-0020): compares the Conditions stored now with the
// deliveries recorded, sends what has come due, and records it once sent. A
// send that fails records nothing, so the next pass sends what is true then:
// an identity that left alert in between is never pushed, and one still at
// alert is pushed with how long it has been there. Recovered messages go first,
// so a delivery that closed while delivery was held closes before its
// identity's next one opens. Only paired Systems are delivered; unpairing a
// System closes its open deliveries without a message. Throws when a send
// fails, after trying both priorities.
export const deliverAlerts = async (
  sql: SQL,
  { dashboard, now, send }: { dashboard: URL; now: number; send: Send },
): Promise<void> => {
  const at = new Date(now);
  await sql`
    UPDATE deliveries d SET closed_at = ${at}
    WHERE closed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM paired_systems p WHERE p.system = d.system)
  `;
  const failures: unknown[] = [];
  const recoveries = await dueRecoveries(sql, now);
  if (recoveries.length > 0) {
    failures.push(
      await sendAndRecord(sql, send, recoveredMessage(recoveries, dashboard), async (tx) => {
        for (const recovery of recoveries) {
          // oxlint-disable-next-line no-await-in-loop -- a pass delivers a handful at most.
          await tx`UPDATE deliveries SET closed_at = ${at} WHERE id = ${recovery.delivery}`;
        }
      }),
    );
  }
  const pushes = await duePushes(sql);
  if (pushes.length > 0) {
    failures.push(
      await sendAndRecord(sql, send, pushMessage(pushes, now, dashboard), async (tx) => {
        for (const push of pushes) {
          // oxlint-disable-next-line no-await-in-loop -- a pass delivers a handful at most.
          await tx`
            INSERT INTO deliveries (system, kind, subject, alert_since, pushed_at)
            VALUES (${push.system}, ${push.kind}, ${push.subject}, ${push.alertSince}, ${at})
            ON CONFLICT (system, kind, subject) WHERE closed_at IS NULL DO NOTHING
          `;
        }
      }),
    );
  }
  const failed = failures.filter((failure) => failure !== undefined);
  const [only] = failed;
  if (failed.length > 1) {
    throw new AggregateError(failed, failed.map(describeError).join('; '));
  }
  if (only !== undefined) {
    throw only;
  }
};
