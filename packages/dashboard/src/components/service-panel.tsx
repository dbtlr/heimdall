import type { ReactNode } from 'react';

import { SUPERVISOR_NAMES, serviceChecks } from '../lib/recorded.ts';
import { cn } from '../lib/utils.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { PhraseText } from './date-time.tsx';
import { RECORD_DOT } from './recorded-panel.tsx';
import { UpdateLines } from './service-installed.tsx';

const HEADING = 'text-xs tracking-[0.06em] text-muted-foreground uppercase';

function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </>
  );
}

// The wide Service page's side panel: each of the Collector's checks on its own
// row, then what the provisioner recorded, the installed version, and the
// upstream's update. A Service its provisioner forgot has no checks to show.
export function ServicePanel({ detail }: { detail: ServiceDetail }) {
  const { installed, now, recorded, unit, update } = detail;
  const checks = recorded === undefined ? undefined : serviceChecks(recorded, now);
  const supervisor =
    recorded === undefined || recorded.supervisor === 'none'
      ? undefined
      : (SUPERVISOR_NAMES[recorded.supervisor] ?? recorded.supervisor);
  return (
    <section className="rounded-lg bg-card p-3 text-sm">
      {checks !== undefined && (
        <>
          <h2 className={HEADING}>Checks</h2>
          {checks.length === 0 ? (
            <p className="mt-1 text-muted-foreground">Not checked yet</p>
          ) : (
            <dl className="mt-1 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
              {checks.map((check, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- checks keep the Hub's order and have no id.
                <Fact key={index} label={check.label}>
                  <span
                    className={cn(
                      'mr-2 inline-block size-2 rounded-full align-middle',
                      RECORD_DOT[check.state],
                    )}
                  />
                  <PhraseText phrase={check.text} />
                </Fact>
              ))}
            </dl>
          )}
        </>
      )}
      <h2 className={cn(HEADING, checks !== undefined && 'mt-4')}>Record</h2>
      <dl className="mt-1 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
        {supervisor !== undefined && <Fact label="Supervisor">{supervisor}</Fact>}
        {unit !== undefined && <Fact label="Unit">{unit}</Fact>}
        <Fact label="Installed">{installed.version ?? 'Unknown'}</Fact>
        {installed.upstream !== null && <Fact label="Upstream">{installed.upstream}</Fact>}
        {installed.missingApplication !== undefined && (
          <Fact label="Application">{installed.missingApplication}, not recorded</Fact>
        )}
      </dl>
      <UpdateLines now={now} update={update} />
    </section>
  );
}
