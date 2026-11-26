import type { SQL } from 'bun';

import { deliveryFailingShown, isAsleep } from '../lib/fleet.ts';
import { agoText, isRunning, judgePass, usualMost } from '../lib/hub-passes.ts';
import type { PassJudgment, PassRecord } from '../lib/hub-passes.ts';
import { harnessName } from '../lib/lane.ts';
import { joinPhrases, whenAt } from '../lib/phrase.ts';
import type { Moment, Phrase } from '../lib/phrase.ts';
import { formatSpanShort } from '../lib/time.ts';
import type { HubCheck, HubRuntime, HubStatus, HubTable } from './hub-status-types.ts';
import { readSnapshot } from './snapshot.ts';

// The gap in the Hub's listening record that counts as an outage, as the Hub
// judges it (LISTENING_GAP_MS in packages/hub/src/listening.ts). Only an older
// Hub, which records no listening pass, is judged down by it.
export const LISTENING_GAP_MS = 2 * 60_000;
// How many items a list that can grow shows before it says how many more.
export const LIST_SHOWN = 3;
// How many of the largest tables Storage names before "everything else".
const TABLES_SHOWN = 5;

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

// "21.3 GiB", "48 MiB", "12 KiB", or "512 B".
export const sizeText = (value: number | string) => {
  const n = Number(value);
  if (n >= GIB) {
    return `${(n / GIB).toFixed(1)} GiB`;
  }
  if (n >= MIB) {
    return `${String(Math.round(n / MIB))} MiB`;
  }
  return n >= KIB ? `${String(Math.round(n / KIB))} KiB` : `${String(n)} B`;
};

// "1 System" or "2 Systems".
export const count = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

// The first LIST_SHOWN of `items` and, past them, "N more".
const capped = (items: string[]) =>
  items.length > LIST_SHOWN
    ? [...items.slice(0, LIST_SHOWN), `${String(items.length - LIST_SHOWN)} more`]
    : items;

const when = (at: Date | null | undefined, now: number): Phrase =>
  at == null ? ['unknown'] : [whenAt(at.getTime(), now)];

const ago = (at: Date | null | undefined, now: number) =>
  at == null ? 'unknown' : agoText(at.getTime(), now);

// A clock offset as "+0.2 s" or "−0.1 s".
const offsetText = (ms: number | null) => {
  if (ms === null) {
    return 'unknown';
  }
  const seconds = (ms / 1000).toFixed(1);
  return ms > 0 ? `+${seconds} s` : `${seconds.replace('-', '−')} s`;
};

// A parser's progress: a rebuild's share of generations read, else how far
// it trails what the archive holds.
const progressText = (p: {
  target: number;
  version: number;
  read: number;
  total: number;
  behind: string;
}) => {
  if (p.target > p.version) {
    const percent = p.total === 0 ? 0 : Math.floor((100 * p.read) / p.total);
    return `Rebuilding to v${String(p.target)}: ${String(p.read)} of ${count(p.total, 'generation')} (${String(percent)}%)`;
  }
  return Number(p.behind) === 0 ? 'Read through: 0 B behind' : `${sizeText(p.behind)} behind`;
};

// Whether the Hub asks this upstream for its releases, as the Hub decides it
// (checkedUpstream in packages/hub/src/upstream-releases.ts). APT and Homebrew
// upstreams come from the Collector's package observations instead.
export const checkedUpstream = (upstream: string) => /^(?:github|npm|oci):/u.test(upstream);

// A failing upstream with its reason, when it was checked, and its next try.
const failingUpstream = (
  u: {
    upstream: string;
    failure: string | null;
    checked_at: Date | null;
    next_check_at: Date | null;
  },
  now: number,
): Phrase => {
  const phrase: (Moment | string)[] = [`${u.upstream} ${u.failure ?? ''}, checked `];
  phrase.push(...when(u.checked_at, now));
  if (u.next_check_at !== null) {
    phrase.push(', next try ', { at: u.next_check_at.getTime(), format: 'ahead', now });
  }
  return phrase;
};

// A pass's record as it would read had its runs not failed.
const withoutFailure = (run: PassRecord): PassRecord => {
  const kept = { ...run };
  delete kept.failing_since;
  return kept;
};

type Runtime = {
  version: string;
  started_at: Date;
  delivery_configured: boolean;
  last_runs: Record<string, PassRecord>;
};

// When the Hub last showed it was running, in epoch milliseconds: the newest
// of its listening heartbeat, its start, and every time a pass recorded, since
// each was written by the running Hub. Undefined when none is recorded.
const lastSignOfLife = (heard: number | undefined, row: Runtime | undefined) => {
  const times = [
    heard,
    row?.started_at.getTime(),
    ...Object.values(row?.last_runs ?? {}).flatMap((run) => [
      run.started_at,
      run.finished_at,
      run.succeeded_at,
    ]),
  ].filter((at) => at !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
};

// The listening pass's record with its heartbeat folded in. The pass's only
// work is the heartbeat, so a heartbeat no older than the run's recorded start
// shows a run started and finished then, even when a held row kept that run's
// status writes out. A run in progress keeps its own start.
const withHeartbeat = (run: PassRecord, heard: number | undefined): PassRecord => {
  if (heard === undefined || (run.started_at !== undefined && heard < run.started_at)) {
    return run;
  }
  return {
    ...run,
    finished_at: Math.max(run.finished_at ?? heard, heard),
    started_at: isRunning(run) ? (run.started_at ?? heard) : heard,
  };
};

// A missing table is expected while a Hub older than its status table runs.
// Read it outside the snapshot: a missing-relation error would otherwise abort
// the whole transaction.
const readRuntime = async (sql: SQL): Promise<{ kind: HubRuntime; row: Runtime | undefined }> => {
  try {
    const [row]: Runtime[] =
      await sql`SELECT version, started_at, delivery_configured, last_runs FROM hub_status`;
    return { kind: row === undefined ? 'empty' : 'recorded', row };
  } catch (error) {
    if (error instanceof Error && 'errno' in error && error.errno === '42P01') {
      return { kind: 'missing', row: undefined };
    }
    throw error;
  }
};

// The Hub version its status row records, for the footer; undefined when the
// row or its table is missing.
export const readHubVersion = async (sql: SQL) => (await readRuntime(sql)).row?.version;

// Direct database reads, with counts only from parser failures. No transcript
// content, failure reason, or delivery destination is selected or sent to the
// browser.
export const readHubStatus = async (sql: SQL, now: number): Promise<HubStatus> => {
  const runtime = await readRuntime(sql);
  return readSnapshot(sql, async (tx) => {
    const checks: HubCheck[] = [];
    const add = (part: string, state: HubCheck['state'], text: Phrase, detail: Phrase = []) => {
      checks.push({ detail, part, state, text });
    };

    const [listening]: { heard_at: Date | null; listening_since: Date | null }[] =
      await tx`SELECT heard_at, listening_since FROM hub_listening`;
    const heard = listening?.heard_at ?? null;
    const hubStartedAt = runtime.row?.started_at.getTime();
    const listeningRun = runtime.row?.last_runs.listening;
    const lastHeard = lastSignOfLife(heard?.getTime(), runtime.row);
    // Until the Hub has recorded nothing for the listening pass's usual most,
    // every pass is judged as of one listening interval after it was last
    // heard, so none goes overdue merely because the Hub stopped. Past that,
    // the page gives one verdict. A Hub older than its status table is judged
    // by its outage limit.
    let isDown = lastHeard !== undefined && now - lastHeard > LISTENING_GAP_MS;
    let asOf = now;
    if (listeningRun?.interval_ms !== undefined && lastHeard !== undefined) {
      isDown = now - lastHeard > usualMost(listeningRun.interval_ms, listeningRun.budget_ms);
      asOf = Math.min(now, lastHeard + listeningRun.interval_ms);
    }
    const down: Phrase | undefined =
      isDown && lastHeard !== undefined
        ? [
            `The Hub has recorded nothing for ${formatSpanShort(now - lastHeard)}: it may be stopped or stuck.`,
          ]
        : undefined;
    const pass = (name: string, label: string, run = runtime.row?.last_runs[name]) =>
      judgePass({ asOf, down: isDown, hubStartedAt, label, now, run });
    // Judged as of now: a listening run that hangs or keeps failing warns
    // here, even while other passes' writes keep the Hub heard.
    const listeningPass = judgePass({
      down: false,
      hubStartedAt,
      label: 'Listening pass',
      now,
      run: listeningRun === undefined ? undefined : withHeartbeat(listeningRun, heard?.getTime()),
    });

    const hubLine: Phrase =
      runtime.row === undefined
        ? ['Hub version unknown']
        : [`Hub v${runtime.row.version}, started `, ...when(runtime.row.started_at, now)];
    if (isDown && lastHeard !== undefined) {
      add('Listening', 'warning', ['Nothing recorded since ', whenAt(lastHeard, now)], hubLine);
    } else if (heard === null) {
      add('Listening', 'unknown', ['No listening recorded yet'], hubLine);
    } else if (listeningPass.stuck) {
      add('Listening', 'warning', listeningPass.phrase, hubLine);
    } else {
      add(
        'Listening',
        'ok',
        ['Since ', ...when(listening?.listening_since, now), `, last recorded ${ago(heard, now)}`],
        hubLine,
      );
    }

    const migrations: { version: number; applied_at: Date }[] =
      await tx`SELECT version, applied_at FROM schema_migrations ORDER BY version DESC`;
    const [size]: { bytes: string }[] =
      await tx`SELECT pg_database_size(current_database())::text AS bytes`;
    const tablesBySize: { name: string; bytes: string }[] = await tx`
      SELECT relname AS name, pg_total_relation_size(relid)::text AS bytes
      FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC`;
    const total = Number(size?.bytes ?? 0);
    const [largest] = tablesBySize;
    add(
      'Database',
      'ok',
      [
        `${sizeText(total)} · schema ${String(migrations[0]?.version ?? 'unknown')}, applied `,
        ...when(migrations[0]?.applied_at, now),
      ],
      largest === undefined ? [] : [`Largest: ${largest.name} ${sizeText(largest.bytes)}`],
    );

    const systems: {
      name: string;
      last_seen_at: Date | null;
      collector_version: string | null;
      sleeps: boolean | null;
      clock_offset_ms: number | null;
      spool_bytes: string | null;
      spool_oldest_at: Date | null;
      stale: boolean;
    }[] = await tx`
      SELECT p.system AS name, s.last_seen_at, s.collector_version, s.sleeps, s.clock_offset_ms,
        t.spool_bytes::text, t.spool_oldest_at,
        EXISTS (SELECT 1 FROM conditions c WHERE c.system = p.system
          AND c.kind = 'system_stale' AND c.cleared_at IS NULL) AS stale
      FROM paired_systems p
      LEFT JOIN systems s ON s.name = p.system
      LEFT JOIN transcript_sources t ON t.system = p.system
      ORDER BY p.system`;
    const lastSeen = (s: (typeof systems)[number]) => {
      if (s.last_seen_at === null) {
        return 'never seen';
      }
      const asleep = isAsleep(
        { lastSeenAt: s.last_seen_at.getTime(), sleeps: s.sleeps === true },
        now,
      );
      return `${agoText(s.last_seen_at.getTime(), now)}${asleep ? ' · asleep' : ''}`;
    };
    // The Hub's own Stale System Conditions decide which Systems are stale,
    // so pairing grace and the Hub's outages count as the Hub counts them.
    const stale = systems.filter((s) => s.stale);
    add(
      'Intake',
      stale.length > 0 ? 'warning' : 'ok',
      [
        `${count(systems.length, 'System')} paired · ${stale.length === 0 ? 'none' : String(stale.length)} stale`,
      ],
      [capped(stale.map((s) => `${s.name} last seen ${lastSeen(s)}`)).join(' · ')],
    );

    const parts: { system: string; part: string; budget: string; unreadable: number }[] = await tx`
      SELECT r.system, 'records' AS part, coalesce(r.over_budget_bytes, 0)::text AS budget,
        jsonb_array_length(r.unreadable)::int AS unreadable
        FROM record_sets r JOIN paired_systems p ON p.system = r.system
      UNION ALL SELECT r.system, 'runs', coalesce(r.over_budget_bytes, 0)::text,
        jsonb_array_length(r.unreadable)::int
        FROM run_sets r JOIN paired_systems p ON p.system = r.system
      UNION ALL SELECT r.system, 'checks',
        (coalesce(r.files_over_budget_bytes, 0) + coalesce(r.services_over_budget_bytes, 0))::text, 0
        FROM check_sets r JOIN paired_systems p ON p.system = r.system`;
    const partsOf = (system: string) =>
      parts
        .filter((p) => p.system === system && (Number(p.budget) > 0 || p.unreadable > 0))
        .map((p) =>
          [
            Number(p.budget) > 0 ? `${p.part} over budget, ${sizeText(p.budget)}` : '',
            p.unreadable > 0 ? `${p.part}: ${String(p.unreadable)} unreadable` : '',
          ]
            .filter(Boolean)
            .join(', '),
        )
        .join(' · ');
    const codes: { system: string; expires_at: Date }[] =
      await tx`SELECT system, expires_at FROM pairing_codes WHERE expires_at > ${new Date(now)} ORDER BY system`;
    const tables: HubTable[] = [];
    tables.push({
      columns: [
        'System',
        'Last seen',
        'Collector',
        'Clock offset',
        'Transcripts waiting on the System',
        'Report parts',
      ],
      notes: capped(
        codes.map(
          (c) =>
            `Pairing code issued for ${c.system}, expires in ${formatSpanShort(c.expires_at.getTime() - now)}.`,
        ),
      ).map((text) => [text]),
      rows: systems.map((s) => [
        [s.name],
        [lastSeen(s)],
        [s.collector_version ?? 'unknown'],
        [offsetText(s.clock_offset_ms)],
        [
          Number(s.spool_bytes ?? 0) > 0
            ? `${sizeText(s.spool_bytes ?? 0)}, oldest ${ago(s.spool_oldest_at, now)}`
            : '—',
        ],
        [partsOf(s.name) || '—'],
      ]),
      title: 'Systems and Collectors',
    });

    const parsers: {
      harness: string;
      version: number;
      target: number;
      failed: number;
      attempts: number;
      behind: string;
      read: number;
      total: number;
    }[] = await tx`
      WITH versions AS (
        SELECT harness, version FROM current_parsers UNION SELECT harness, parser_version FROM parse_progress
      ), targets AS (SELECT harness, max(version) AS target FROM versions GROUP BY harness)
      SELECT t.harness, coalesce(c.version, 0) AS version, t.target,
        count(*) FILTER (WHERE p.failed_at IS NOT NULL)::int AS failed,
        coalesce(max(p.failed_attempts), 0)::int AS attempts,
        coalesce(sum(greatest(g.held - coalesce(p.parsed_through, 0), 0)), 0)::text AS behind,
        count(*) FILTER (WHERE coalesce(p.parsed_through, 0) >= g.held)::int AS read, count(g.id)::int AS total
      FROM targets t LEFT JOIN current_parsers c ON c.harness = t.harness
      LEFT JOIN (
        SELECT h.harness, g.id FROM transcript_generations g JOIN transcript_source_harnesses h
          ON h.system = g.system AND h.source = g.source
        UNION SELECT harness, generation FROM parse_progress
      ) generations ON generations.harness = t.harness
      LEFT JOIN transcript_generations g ON g.id = generations.id AND g.deleted_at IS NULL
      LEFT JOIN parse_progress p ON p.harness = t.harness AND p.parser_version = t.target AND p.generation = g.id
      GROUP BY t.harness, c.version, t.target ORDER BY t.harness`;
    const failed = parsers.reduce((sum, p) => sum + p.failed, 0);
    const behind = parsers.reduce((sum, p) => sum + Number(p.behind), 0);
    const percent = (p: (typeof parsers)[number]) =>
      p.total === 0 ? 0 : Math.floor((100 * p.read) / p.total);
    const rebuilds = parsers
      .filter((p) => p.target > p.version)
      .map(
        (p) =>
          `${harnessName(p.harness)} parser rebuilding to v${String(p.target)}, ${String(percent(p))}%`,
      );
    const parse = pass('parse', 'Parse pass');
    const readThrough = behind === 0 ? 'Read through' : `${sizeText(behind)} behind`;
    add(
      'Session insight',
      failed > 0 || parse.stuck ? 'warning' : parse.state,
      [
        `${rebuilds.length > 0 ? rebuilds.join(' · ') : readThrough} · ${failed === 0 ? '0 failed' : `${count(failed, 'generation')} failed`}`,
      ],
      rebuilds.length > 0 && parse.stuck
        ? ['Parser rebuild stalled: ', ...parse.phrase]
        : parse.phrase,
    );
    // Only the failures shown come back, with how many there are in all.
    const failures: {
      system: string;
      source: string;
      failed_attempts: number;
      failed_at: Date;
      total: number;
    }[] = await tx`
      SELECT g.system, g.source, p.failed_attempts, p.failed_at, (count(*) OVER ())::int AS total
      FROM parse_progress p
      JOIN transcript_generations g ON g.id = p.generation
      WHERE g.deleted_at IS NULL AND p.failed_at IS NOT NULL
        AND p.parser_version >= coalesce((SELECT version FROM current_parsers c WHERE c.harness = p.harness), 0)
      ORDER BY p.failed_at DESC, g.system, g.source
      LIMIT ${LIST_SHOWN}`;
    const failuresInAll = failures[0]?.total ?? 0;
    const failureNotes: Phrase[] = failures.map((f) => [
      `Failed generation: ${f.system}, source ${f.source}, ${count(f.failed_attempts, 'attempt')}, failed `,
      whenAt(f.failed_at.getTime(), now),
      '.',
    ]);
    if (failuresInAll > LIST_SHOWN) {
      failureNotes.push([
        `${count(failuresInAll - LIST_SHOWN, 'more failed generation', 'more failed generations')}.`,
      ]);
    }
    if (failuresInAll > 0) {
      failureNotes.push(['The reason is kept out of the dashboard.']);
    }
    tables.push({
      columns: ['Harness', 'Parser', 'Progress', 'Failed'],
      notes: failureNotes,
      rows: parsers.map((p) => [
        [harnessName(p.harness)],
        [`v${String(p.version)}`],
        [progressText(p)],
        [
          p.failed === 0
            ? '—'
            : `${count(p.failed, 'generation')} failed, up to ${count(p.attempts, 'time')}`,
        ],
      ]),
      title: 'Session insight',
    });

    const [backlog]: { sessions: number; ranges: number; rederiving: number; retries: number }[] =
      await tx`SELECT
      (SELECT count(*)::int FROM stale_sessions) AS sessions,
      (SELECT count(*)::int FROM stale_ranges) AS ranges,
      (SELECT count(*)::int FROM rederiving_sessions) AS rederiving,
      (SELECT count(*)::int FROM stale_sessions WHERE attempts > 0) AS retries`;
    const refresh = pass('refresh', 'Refresh');
    const retries = backlog?.retries ?? 0;
    add(
      'Stored Session totals',
      retries > 0 || refresh.stuck ? 'warning' : refresh.state,
      [
        [
          `${count(backlog?.sessions ?? 0, 'Session')} waiting to refresh`,
          count(backlog?.ranges ?? 0, 'range'),
          `${String(backlog?.rederiving ?? 0)} rederiving`,
          retries === 0 ? 'no refresh retries' : count(retries, 'refresh retry', 'refresh retries'),
        ].join(' · '),
      ],
      refresh.phrase,
    );

    const evaluations: { system: string; load: Date | null; process: Date | null }[] = await tx`
      SELECT p.system, l.through AS load, h.through AS process FROM paired_systems p
      LEFT JOIN load_evaluations l ON l.system = p.system
      LEFT JOIN hot_process_evaluations h ON h.system = p.system ORDER BY p.system`;
    const throughs = evaluations.flatMap((e) => [e.load, e.process]);
    const oldest = throughs.every((t) => t !== null)
      ? throughs.reduce<Date | null>(
          (min, t) => (min === null || (t !== null && t < min) ? t : min),
          null,
        )
      : null;
    const conditions = pass('conditions', 'Condition evaluation');
    const notEvaluated = evaluations.filter((e) => e.load === null || e.process === null);
    let evaluatedDetail: Phrase = [];
    if (notEvaluated.length > 0) {
      evaluatedDetail = [
        `Load and hot processes not yet evaluated on ${capped(notEvaluated.map((e) => e.system)).join(', ')}`,
      ];
    } else if (oldest !== null) {
      evaluatedDetail = [
        `Load and hot processes evaluated through ${ago(oldest, now)} on every System`,
      ];
    }
    add('Conditions', conditions.state, conditions.phrase, evaluatedDetail);

    const [delivery]: {
      failing_since: Date | null;
      open: number;
      unpushed: number;
      last_push: Date | null;
    }[] = await tx`SELECT failing_since,
      (SELECT count(*)::int FROM deliveries WHERE closed_at IS NULL) AS open,
      (SELECT max(pushed_at) FROM deliveries) AS last_push,
      -- What the Hub's next delivery pass would push (duePushes in packages/hub/src/delivery.ts).
      (SELECT count(*)::int FROM conditions c JOIN paired_systems p ON p.system = c.system
        WHERE c.cleared_at IS NULL AND c.level = 'alert'
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE (d.system, d.kind, d.subject) = (c.system, c.kind, c.subject) AND d.closed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM silences s WHERE s.system = c.system AND s.until > ${new Date(now)})
      ) AS unpushed
      FROM delivery_status`;
    const silences: { system: string; until: Date }[] =
      await tx`SELECT system, until FROM silences WHERE until > ${new Date(now)} ORDER BY until, system`;
    const silenced: Phrase = joinPhrases(
      [
        ...silences
          .slice(0, LIST_SHOWN)
          .map((s): Phrase => [
            `${s.system} silenced until `,
            { at: s.until.getTime(), format: 'ahead', now } satisfies Moment,
          ]),
        ...(silences.length > LIST_SHOWN
          ? [[count(silences.length - LIST_SHOWN, 'more silence')]]
          : []),
      ],
      ' · ',
    );
    const deliveryDetail = joinPhrases(
      [
        [
          'Last push ',
          ...(delivery?.last_push == null ? ['none yet'] : when(delivery.last_push, now)),
        ],
        [count(delivery?.open ?? 0, 'open delivery', 'open deliveries')],
        silenced,
      ],
      ' · ',
    );
    // A failed send fails the delivery pass too, so the pass's own failure
    // waits for Home's 10 minutes as the delivery status's does. A pass that
    // falls behind still warns on its own schedule.
    const deliveryRun = runtime.row?.last_runs.delivery;
    const deliveryFailures = [
      delivery?.failing_since?.getTime(),
      deliveryRun?.failing_since,
    ].filter((at) => at !== undefined);
    const failingSince = deliveryFailingShown({
      deliveryFailingSince:
        deliveryFailures.length === 0 ? undefined : Math.min(...deliveryFailures),
      now,
    });
    const deliveryPass = pass(
      'delivery',
      'Delivery pass',
      deliveryRun === undefined ? undefined : withoutFailure(deliveryRun),
    );
    if (runtime.row === undefined) {
      add('Alert delivery', 'unknown', ['Configuration unknown'], deliveryDetail);
    } else if (!runtime.row.delivery_configured) {
      add('Alert delivery', 'ok', ['Not configured'], silenced);
    } else if (failingSince !== undefined && !isDown) {
      const unpushed = delivery?.unpushed ?? 0;
      add(
        'Alert delivery',
        'warning',
        [
          'Failing since ',
          whenAt(failingSince, now),
          ` (${formatSpanShort(now - failingSince)})`,
          ...(unpushed > 0 ? [` · ${count(unpushed, 'alert')} not pushed`] : []),
        ],
        deliveryDetail,
      );
    } else {
      add('Alert delivery', deliveryPass.state, deliveryPass.phrase, deliveryDetail);
    }

    // Only upstreams a System records now and the Hub asks for releases: the
    // Hub checks no other, so an upstream no System records any more keeps its
    // last failure forever, and an APT or Homebrew one is never checked.
    const upstreams: {
      upstream: string;
      failure: string | null;
      checked_at: Date | null;
      next_check_at: Date | null;
    }[] = await tx`
      WITH current AS (
        SELECT DISTINCT ON (v.system, v.service) v.system, v.service, v.upstream
        FROM service_versions v ORDER BY v.system, v.service, v.first_seen_at DESC
      ), recorded AS (
        SELECT DISTINCT c.upstream FROM current c
        JOIN mirrored_records r ON r.system = c.system AND r.kind = 'service' AND r.name = c.service
        WHERE c.upstream IS NOT NULL
      )
      SELECT r.upstream, u.failure, u.checked_at, u.next_check_at
      FROM recorded r LEFT JOIN upstream_checks u ON u.upstream = r.upstream
      ORDER BY r.upstream`;
    const checkable = upstreams.filter((u) => checkedUpstream(u.upstream));
    const checked = checkable.filter((u) => u.checked_at !== null);
    const failing = checkable.filter((u) => u.failure !== null);
    const upstreamPass = pass('upstreams', 'Upstream pass');
    add(
      'Upstream checks',
      failing.length > 0 || upstreamPass.stuck ? 'warning' : upstreamPass.state,
      [
        `${String(checked.length)} of ${count(checkable.length, 'upstream')} checked · ${failing.length === 0 ? 'none failing' : `${String(failing.length)} failing`}`,
      ],
      failing.length === 0
        ? upstreamPass.phrase
        : joinPhrases(
            [
              ...failing.slice(0, LIST_SHOWN).map((u) => failingUpstream(u, now)),
              ...(failing.length > LIST_SHOWN
                ? [[`${String(failing.length - LIST_SHOWN)} more failing`]]
                : []),
            ],
            ' · ',
          ),
    );

    // A Hub older than its fetched prices has only the table of bundled and
    // configured ones.
    const [fetchedTable]: { present: boolean }[] =
      await tx`SELECT to_regclass('fetched_model_prices') IS NOT NULL AS present`;
    const [prices]: { models: number; configured: number; fetched: number }[] =
      fetchedTable?.present === true
        ? await tx`
          SELECT count(DISTINCT model)::int AS models,
                 count(DISTINCT model) FILTER (WHERE source = 'configured')::int AS configured,
                 count(DISTINCT model) FILTER (WHERE source = 'fetched')::int AS fetched
          FROM (SELECT model, source FROM model_prices
                UNION ALL SELECT model, 'fetched' FROM fetched_model_prices) p`
        : await tx`
          SELECT count(DISTINCT model)::int AS models,
                 count(DISTINCT model) FILTER (WHERE source = 'configured')::int AS configured,
                 0 AS fetched
          FROM model_prices`;
    const [unpriced]: { requests: string }[] =
      await tx`SELECT coalesce(sum(unpriced_requests), 0)::text AS requests FROM insight.session_model_totals`;
    const unpricedCount = Number(unpriced?.requests ?? 0);
    const pricesRun = runtime.row?.last_runs.prices;
    const priceFetch: Pick<PassJudgment, 'phrase' | 'state'> =
      pricesRun?.off === true
        ? { phrase: ['Fetching off'], state: 'ok' }
        : pass('prices', 'Price fetch', pricesRun);
    add(
      'Price table',
      priceFetch.state,
      [
        `${count(prices?.models ?? 0, 'model')}, ${String(prices?.configured ?? 0)} configured, ${String(prices?.fetched ?? 0)} fetched`,
      ],
      joinPhrases(
        [
          priceFetch.phrase,
          [
            unpricedCount === 0
              ? 'Every stored request has a price'
              : `${count(unpricedCount, 'unpriced request')} in stored Session totals`,
          ],
        ],
        ' · ',
      ),
    );

    const [kept]: { raw: Date | null; rollup: Date | null }[] = await tx`
      SELECT min(v.t) AS raw, min(r.bucket) AS rollup FROM systems s
      LEFT JOIN LATERAL (SELECT t FROM vitals_samples WHERE system = s.name ORDER BY t LIMIT 1) v ON true
      LEFT JOIN LATERAL (SELECT bucket FROM vitals_rollups WHERE system = s.name ORDER BY bucket LIMIT 1) r ON true`;
    const prune = pass('prune', 'Prune');
    const age = (at: Date | null | undefined) =>
      at == null ? 'none' : formatSpanShort(Math.max(0, now - at.getTime()));
    add(
      'Retention',
      prune.state,
      [`Oldest raw sample ${age(kept?.raw)} · oldest rollup ${age(kept?.rollup)}`],
      joinPhrases([prune.phrase, ['raw Vitals kept 14 days, rollups 365 days']], ' · '),
    );

    const shown = tablesBySize.slice(0, TABLES_SHOWN);
    const rest = total - shown.reduce((sum, t) => sum + Number(t.bytes), 0);
    const [archive]: {
      generations: number;
      held: string;
      stored: string;
      uploaded: Date | null;
    }[] = await tx`SELECT count(*)::int AS generations, coalesce(sum(held), 0)::text AS held,
        coalesce(sum(stored_bytes), 0)::text AS stored, max(last_upload_at) AS uploaded
        FROM transcript_generations`;
    tables.push({
      aside: sizeText(total),
      columns: ['Table', 'Size'],
      notes:
        archive === undefined
          ? []
          : [
              [
                `Transcript archive: ${count(archive.generations, 'generation')}, ${sizeText(archive.held)} as written, ${sizeText(archive.stored)} stored · last upload ${ago(archive.uploaded, now)}.`,
              ],
            ],
      rows: [
        ...shown.map((t) => [[t.name], [sizeText(t.bytes)]]),
        ...(tablesBySize.length > TABLES_SHOWN
          ? [[['everything else'], [sizeText(Math.max(0, rest))]]]
          : []),
      ],
      title: 'Storage',
    });

    const details: HubTable[] = [
      {
        columns: ['System', 'Load evaluated through', 'Hot processes evaluated through'],
        notes: [],
        rows: evaluations.map((e) => [[e.system], when(e.load, now), when(e.process, now)]),
        title: 'Condition evaluations',
      },
      {
        columns: ['Migration', 'Applied'],
        notes: [],
        rows: migrations.map((m) => [[String(m.version)], when(m.applied_at, now)]),
        title: 'Migrations applied',
      },
    ];
    return { checks, details, down, runtime: runtime.kind, tables, version: runtime.row?.version };
  });
};
