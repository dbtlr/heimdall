import { MAX_CHECK_DETAIL_LENGTH } from '@heimdall/schema';
import type { ServiceCheckKind, ServiceCheckState } from '@heimdall/schema';

// What one check of a Service found.
export type ServiceOutcome = {
  check: ServiceCheckKind;
  detail: string;
  state: ServiceCheckState;
};

// A detail the Hub takes whatever a supervisor printed into it: control
// characters, which could rewrite a terminal or break a line, are taken out, a
// lone surrogate is replaced, and the text is cut to the length the Hub takes
// without cutting through a surrogate pair, so a long or odd value cannot get
// the whole checks section refused.
export const clampDetail = (detail: string) => {
  const cut = detail
    .replaceAll(/\p{Cc}/gu, '')
    .toWellFormed()
    .slice(0, MAX_CHECK_DETAIL_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate at the end is the first half of a pair the cut split.
  return last >= 0xd8_00 && last <= 0xdb_ff ? cut.slice(0, -1) : cut;
};

// The outcome of a Service's supervisor check.
export const supervisorOutcome = (state: ServiceCheckState, detail: string): ServiceOutcome => ({
  check: 'supervisor',
  detail: clampDetail(detail),
  state,
});
