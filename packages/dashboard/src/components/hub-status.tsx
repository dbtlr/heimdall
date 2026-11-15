import type { HubStatus } from '../server/hub-status-types.ts';

const DOT = { ok: 'bg-status-good', unknown: 'bg-muted-foreground', warning: 'bg-status-serious' };

// Checklist first at both widths; tables scroll within their cards on phones.
export function HubStatusContent({ status }: { status: HubStatus }) {
  const warnings = status.checks.filter((c) => c.state === 'warning');
  const unknown = status.checks.some((c) => c.state === 'unknown');
  let verdict = 'All well';
  let summary = 'Every part of the Hub is current.';
  if (unknown) {
    verdict = 'Some status unknown';
    summary = 'Upgrade the Hub to record its version, delivery configuration, and timer passes.';
  }
  if (warnings.length > 0) {
    verdict = `${warnings.length} need a look`;
    summary = `${warnings.map((c) => c.part).join(', ')} need attention. See each row below.`;
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 pt-5 pb-3 sm:pt-6">
        <h1 className="text-2xl font-semibold sm:text-[28px]">Hub status</h1>
        <span className="rounded-full border px-3 py-1 text-sm">{verdict}</span>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">{summary}</p>
      <section
        aria-label="Hub health checklist"
        className="divide-y rounded-xl border card-surface"
      >
        {status.checks.map((c) => (
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr]" key={c.part}>
            <div className="flex items-center gap-2 font-semibold">
              <span
                aria-label={c.state}
                className={`size-2 shrink-0 rounded-full ${DOT[c.state]}`}
              />
              {c.part}
            </div>
            <div className="min-w-0 break-words text-sm">
              <p>{c.text}</p>
              {c.detail && <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>}
            </div>
          </div>
        ))}
      </section>
      {status.tables.map((table) => (
        <section className="mt-5 overflow-hidden rounded-xl border card-surface" key={table.title}>
          <h2 className="px-4 py-3 text-base font-semibold">{table.title}</h2>
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
              <tbody className="divide-y">
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td className="px-4 py-2 align-top" key={j}>
                        {cell}
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
        </section>
      ))}
    </>
  );
}
