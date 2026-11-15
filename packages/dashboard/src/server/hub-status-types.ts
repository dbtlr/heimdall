import type { Phrase } from '../lib/phrase.ts';

export type HubCheckState = 'ok' | 'warning' | 'unknown';

// One row of the checklist: the part of the Hub, its state, a sentence, and
// the evidence under it.
export type HubCheck = {
  part: string;
  state: HubCheckState;
  text: Phrase;
  detail: Phrase;
};

// A table with an optional figure beside its title, such as storage's total,
// and sentences under it.
export type HubTable = {
  title: string;
  aside?: string;
  columns: string[];
  rows: Phrase[][];
  notes: Phrase[];
};

// Whether the Hub's own status row could be read: `missing` when the Hub is
// older than its status table, `empty` before a Hub has written the row, and
// `recorded` once one has.
export type HubRuntime = 'missing' | 'empty' | 'recorded';

export type HubStatus = {
  runtime: HubRuntime;
  // The Hub version the status row records, when it does.
  version: string | undefined;
  // Set when the Hub has recorded nothing, neither its heartbeat nor any
  // pass, for longer than the listening pass's usual most: one plain verdict
  // that replaces every stale row's own.
  down: Phrase | undefined;
  checks: HubCheck[];
  tables: HubTable[];
  // Tables the mock leaves out, folded behind one Details disclosure.
  details: HubTable[];
};
