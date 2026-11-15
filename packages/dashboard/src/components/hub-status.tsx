import type { ReactNode } from 'react';

import type { Phrase } from '../lib/phrase.ts';
import type { HubCheck, HubStatus, HubTable } from '../server/hub-status-types.ts';
import { PhraseText } from './date-time.tsx';

const DOT = { ok: 'bg-status-good', unknown: 'bg-muted-foreground', warning: 'bg-status-serious' };

// "A", "A and B", or "A, B, and C".
const listText = (items: string[]) =>
  items.length < 3
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')}, and ${items.at(-1) ?? ''}`;

const UPGRADE = 'Upgrade the Hub to record its version, delivery configuration, and timer passes.';

// The page's verdict and the sentence under it. A Hub that is not running says
// so once, instead of every part it leaves behind warning on its own. A Hub
// older than its status table is asked to upgrade whatever else the page says.
export const hubVerdict = (status: HubStatus): { verdict: string; summary: Phrase } => {
  const upgrade = status.runtime === 'missing' ? [` ${UPGRADE}`] : [];
  if (status.down !== undefined) {
    return { summary: [...status.down, ...upgrade], verdict: 'Hub not running' };
  }
  const warnings = status.checks.filter((c) => c.state === 'warning').map((c) => c.part);
  const unknown = status.checks.some((c) => c.state === 'unknown');
  if (warnings.length > 0) {
    const one = warnings.length === 1;
    return {
      summary: [
        `${listText(warnings)} ${one ? 'needs' : 'need'} attention.${unknown ? '' : ' Everything else is current.'}`,
        ...upgrade,
      ],
      verdict: `${String(warnings.length)} ${one ? 'needs' : 'need'} a look`,
    };
  }
  if (status.runtime === 'missing') {
    return { summary: [UPGRADE], verdict: 'Some status unknown' };
  }
  if (status.runtime === 'empty') {
    return {
      summary: ['The Hub records its version and timer passes once it is listening.'],
      verdict: 'Some status unknown',
    };
  }
  if (unknown) {
    return { summary: ['Some parts have not reported yet.'], verdict: 'Some status unknown' };
  }
  return { summary: ['Every part of the Hub is current.'], verdict: 'All well' };
};

function Check({ check }: { check: HubCheck }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr]">
      <div className="flex items-center gap-2 font-semibold">
        <span
          aria-label={check.state}
          className={`size-2 shrink-0 rounded-full ${DOT[check.state]}`}
        />
        {check.part}
      </div>
      <div className="min-w-0 break-words text-sm">
        <p>
          <PhraseText phrase={check.text} />
        </p>
        {check.detail.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            <PhraseText phrase={check.detail} />
          </p>
        )}
      </div>
    </div>
  );
}

function Table({ table }: { table: HubTable }) {
  return (
    <section className="mt-5 overflow-hidden rounded-xl border card-surface">
      <h2 className="flex items-baseline justify-between gap-3 px-4 py-3 text-base font-semibold">
        {table.title}
        {table.aside !== undefined && (
          <span className="text-sm font-normal text-muted-foreground tabular-nums">
            {table.aside}
          </span>
        )}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-y text-xs text-muted-foreground">
            <tr>
              {table.columns.map((c) => (
                <th className="px-4 py-2 font-medium" key={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {table.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td className="px-4 py-2 align-top" key={j}>
                    <PhraseText phrase={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">None recorded</p>
        )}
      </div>
      {table.notes.length > 0 && (
        <div className="space-y-1 border-t px-4 py-3 text-xs text-muted-foreground">
          {table.notes.map((note, i) => (
            <p key={i}>
              <PhraseText phrase={note} />
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

// Shown as is from 640 px up; folded under `label` on a phone, so the
// checklist comes first there.
function FoldOnPhone({ children, label }: { children: ReactNode; label: string }) {
  return (
    <>
      <div className="hidden sm:block">{children}</div>
      <details className="mt-5 sm:hidden">
        <summary className="min-h-11 cursor-pointer py-2.5 text-base text-primary">{label}</summary>
        {children}
      </details>
    </>
  );
}

// The checklist first, then the tables the mock shows, then one Details
// disclosure for the rest.
export function HubStatusContent({ status }: { status: HubStatus }) {
  const { summary, verdict } = hubVerdict(status);
  const titles = status.tables.map((t) => t.title);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 pt-5 pb-3 sm:pt-6">
        <h1 className="text-2xl font-semibold sm:text-[28px]">Hub status</h1>
        <span className="rounded-full border px-3 py-1 text-sm">{verdict}</span>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">
        <PhraseText phrase={summary} />
      </p>
      <section
        aria-label="Hub health checklist"
        className="divide-y rounded-xl border card-surface"
      >
        {status.checks.map((c) => (
          <Check check={c} key={c.part} />
        ))}
      </section>
      <FoldOnPhone label={listText(titles)}>
        {status.tables.map((table) => (
          <Table key={table.title} table={table} />
        ))}
      </FoldOnPhone>
      {status.details.length > 0 && (
        <details className="mt-5">
          <summary className="min-h-11 cursor-pointer py-2.5 text-base text-primary">
            Details: {listText(status.details.map((t) => t.title.toLowerCase()))}
          </summary>
          {status.details.map((table) => (
            <Table key={table.title} table={table} />
          ))}
        </details>
      )}
    </>
  );
}
