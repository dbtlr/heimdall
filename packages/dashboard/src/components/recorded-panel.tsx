import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import {
  applicationLine,
  filesLine,
  jobLine,
  provenanceLine,
  serviceLine,
} from '../lib/recorded.ts';
import type { RecordState } from '../lib/recorded.ts';
import { cn } from '../lib/utils.ts';
import type { Recorded } from '../server/system-detail-types.ts';
import { PhraseText } from './date-time.tsx';
import { MoreItems } from './more-items.tsx';

// The dot that shows how a recorded thing stands.
export const RECORD_DOT: Record<RecordState, string> = {
  bad: 'bg-status-critical',
  good: 'bg-status-good',
  unknown: 'border-[1.5px] border-muted-foreground',
  warning: 'bg-status-warning',
};

function Row({
  children,
  name,
  state,
  system,
}: {
  children: ReactNode;
  name: string;
  state?: RecordState;
  // The System of a Service, whose name then links to its page.
  system?: string;
}) {
  return (
    <li className="grid grid-cols-[8px_1fr] items-baseline gap-x-3 gap-y-0.5 py-[3px] sm:grid-cols-[8px_minmax(130px,auto)_1fr]">
      <span
        className={cn('size-2 self-center rounded-full', state !== undefined && RECORD_DOT[state])}
      />
      <b className="min-w-0 font-semibold wrap-anywhere">
        {system === undefined ? (
          name
        ) : (
          <Link
            className="text-primary"
            params={{ name: system, service: name }}
            to="/systems/$name/services/$service"
          >
            {name}
          </Link>
        )}
      </b>
      <span className="col-start-2 min-w-0 wrap-anywhere text-muted-foreground sm:col-start-auto">
        {children}
      </span>
    </li>
  );
}

function Group({ children, count, title }: { children: ReactNode; count: number; title: string }) {
  if (count > 3) {
    return (
      <MoreItems label={`${title} (${String(count)})`}>
        <ul>{children}</ul>
      </MoreItems>
    );
  }
  return (
    <>
      <h3 className="mt-3 mb-0.5 border-t pt-2 text-xs font-normal tracking-[0.06em] text-muted-foreground uppercase first-of-type:mt-0 first-of-type:border-t-0 first-of-type:pt-0">
        {title}
      </h3>
      <ul>{children}</ul>
    </>
  );
}

// Everything the System's provisioner recorded, grouped by kind, each with
// how the Collector found it: Services with their checks, each linking to its
// page, jobs with their latest run, files records with their Drift, and
// Applications.
export function RecordedPanel({
  now,
  recorded,
  system,
}: {
  now: number;
  recorded: Recorded;
  system: string;
}) {
  const { applications, files, jobs, services } = recorded;
  const provenance = provenanceLine(applications);
  const empty = applications.length + files.length + jobs.length + services.length === 0;
  return (
    <section className="mt-[18px] rounded-lg bg-card p-4">
      <h2 className="mb-2 text-[12.5px] font-normal text-muted-foreground">Recorded</h2>
      {empty && <p>Its provisioner has recorded nothing.</p>}
      {services.length > 0 && (
        <Group count={services.length} title="Services">
          {services.map((service) => {
            const { state, text } = serviceLine(service, now);
            return (
              <Row key={service.name} name={service.name} state={state} system={system}>
                <PhraseText phrase={text} />
              </Row>
            );
          })}
        </Group>
      )}
      {jobs.length > 0 && (
        <Group count={jobs.length} title="Jobs">
          {jobs.map((job) => {
            const { state, text } = jobLine(job, now);
            return (
              <Row key={job.name} name={job.name} state={state}>
                <PhraseText phrase={text} />
              </Row>
            );
          })}
        </Group>
      )}
      {files.length > 0 && (
        <Group count={files.length} title="Files">
          {files.map((record) => {
            const { issues, rest, state } = filesLine(record, now);
            return (
              <Row key={record.name} name={record.name} state={state}>
                {issues.map((issue) => (
                  <span className="block" key={issue.path}>
                    <code className="font-mono text-[12.5px] break-all text-foreground">
                      {issue.path}
                    </code>
                    <PhraseText phrase={[' ', ...issue.text, '.']} />
                  </span>
                ))}
                {rest}
              </Row>
            );
          })}
        </Group>
      )}
      {applications.length > 0 && (
        <Group count={applications.length} title="Applications">
          {applications.map((application) => (
            <Row key={application.name} name={application.name}>
              {applicationLine(application)}
            </Row>
          ))}
        </Group>
      )}
      {provenance !== undefined && (
        <p className="mt-1.5 text-xs text-muted-foreground">{provenance}</p>
      )}
    </section>
  );
}
