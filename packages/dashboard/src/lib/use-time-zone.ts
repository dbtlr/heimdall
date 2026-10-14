import { useSyncExternalStore } from 'react';

let browserZone: string | undefined;

// The zone never changes while the page is open, so it is read once.
const browserTimeZone = () =>
  (browserZone ??= new Intl.DateTimeFormat().resolvedOptions().timeZone);

const subscribe = () => () => {};

// The viewer's browser time zone, or undefined while rendering on the server
// and on the first client render, which must match it. Anything that writes a
// time shows nothing until this is known.
export const useTimeZone = (): string | undefined =>
  useSyncExternalStore(subscribe, browserTimeZone, () => undefined);
