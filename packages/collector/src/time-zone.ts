import { readlinkSync } from 'node:fs';

import { TIME_ZONE } from '@heimdall/schema';

const LOCALTIME = '/etc/localtime';
const ZONEINFO_SEGMENT = 'zoneinfo/';

// The IANA zone a `/etc/localtime` link points at, such as `Europe/Paris` for
// `/usr/share/zoneinfo/Europe/Paris`, or undefined when the target names no
// `zoneinfo/` path or a zone the Hub would reject. The zone is what follows the
// last `zoneinfo/`, less a leading `posix/` or `right/`.
export const zoneOfLocaltimeLink = (target: string): string | undefined => {
  const at = target.lastIndexOf(ZONEINFO_SEGMENT);
  if (at === -1) {
    return undefined;
  }
  const zone = target.slice(at + ZONEINFO_SEGMENT.length).replace(/^(?:posix|right)\//u, '');
  return TIME_ZONE.test(zone) ? zone : undefined;
};

// The IANA name of this System's time zone, or undefined when it cannot be
// told. It is the zone `/etc/localtime` links to, which systemd and macOS
// record and whose changes launchd and systemd timers follow, and it is read on
// every call. The process's own `TZ` and the runtime's cached zone are not
// consulted: either can differ from what the schedulers use. A Report carries
// the zone only when it is valid, so the Hub never rejects a Report over it.
// `readLink` returns a link's target, and is a parameter so a test can supply
// another.
export const systemTimeZone = (
  // One syscall, at most every 15 seconds, so it blocks the loop for no time worth an async hop.
  // oxlint-disable-next-line node/no-sync -- see above.
  readLink: (path: string) => string = (path) => readlinkSync(path),
): string | undefined => {
  try {
    return zoneOfLocaltimeLink(readLink(LOCALTIME));
  } catch {
    // Missing, or not a link.
    return undefined;
  }
};
