import { TIME_ZONE } from '@heimdall/schema';

// The IANA name of this System's time zone, such as `Europe/Paris`, or undefined
// when the runtime gives none the Hub would accept. A Report carries it only
// when it is valid, so the Hub never rejects a Report over it. `resolve` is
// what the runtime says, and is a parameter so a test can supply another.
export const systemTimeZone = (
  resolve: () => string = () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | undefined => {
  const zone = resolve();
  return TIME_ZONE.test(zone) ? zone : undefined;
};
