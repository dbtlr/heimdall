import { whenAt } from '../lib/phrase.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { DateTime } from './date-time.tsx';

// The installed version under the status line, with its upstream when known,
// and the Application the Service names when it is not recorded.
export function InstalledLine({ installed }: { installed: ServiceDetail['installed'] }) {
  const { missingApplication, upstream, version } = installed;
  return (
    <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
      {version === null ? 'Installed version unknown' : `Installed ${version}`}
      {version !== null && upstream !== null && ` · ${upstream}`}
      {missingApplication !== undefined &&
        ` · names Application ${missingApplication}, which is not recorded`}
    </p>
  );
}

// The result of comparing the installed version with the upstream's releases.
function UpdateFact({ now, status }: { now: number; status: ServiceDetail['update']['status'] }) {
  if (status === undefined) {
    return null;
  }
  let fact;
  if (status.kind === 'current') {
    fact = 'Up to date';
  } else if (status.kind === 'unreadable') {
    fact = `Version ${status.version} can't be compared`;
  } else {
    fact = (
      <>
        Update {status.version}
        {status.source === 'upstream'
          ? status.since !== undefined && (
              <>
                {' '}
                · available since <DateTime at={status.since} format="dated" now={now} />
              </>
            )
          : ` · from the ${status.source} check`}
      </>
    );
  }
  return <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">{fact}</p>;
}

// The Hub's failure reasons mostly end a sentence already.
const sentence = (text: string) => (/[.!?]$/u.test(text) ? text : `${text}.`);

// Available updates and check failures are facts, independent of Service status.
export function UpdateLines({ now, update }: { now: number; update: ServiceDetail['update'] }) {
  const { failure, status } = update;
  return (
    <>
      <UpdateFact now={now} status={status} />
      {failure !== undefined && (
        <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
          Last check failed <DateTime {...whenAt(failure.at, now)} />: {sentence(failure.reason)}{' '}
          {failure.succeededAt === null ? (
            'It has never succeeded.'
          ) : (
            <>
              Last succeeded <DateTime {...whenAt(failure.succeededAt, now)} />.
            </>
          )}
        </p>
      )}
    </>
  );
}
