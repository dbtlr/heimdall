import type { MemoryHoldersView } from '../lib/detail.ts';
import { clockSecondsAt } from '../lib/phrase.ts';
import { PhraseText } from './date-time.tsx';

// The processes holding the most memory at one sample, largest first, under a
// small heading. The rows are not summed: resident memory counts shared pages
// in every process that maps them.
export function MemoryHolders({ holders }: { holders: MemoryHoldersView }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-1 text-[12.5px] font-normal text-muted-foreground">
        Processes holding the most memory
      </h2>
      <ul>
        {holders.rows.map((row) => (
          <li className="flex min-w-0 items-baseline gap-2 py-0.5 text-[13.5px]" key={row.pid}>
            <b className="min-w-0 font-semibold wrap-anywhere">{row.name}</b>
            <span className="text-muted-foreground">pid {row.pid}</span>
            <span className="ml-auto tabular-nums">{row.resident}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">
        Resident memory, sampled at <PhraseText phrase={[clockSecondsAt(holders.at)]} />. Shared
        pages count in every process that maps them.
      </p>
    </section>
  );
}
