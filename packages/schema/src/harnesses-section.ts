import { z } from 'zod';

// The most installs a Report's harnesses section lists. A Collector keeps the
// first ones in sorted order, so the section never makes a Report too large.
export const MAX_HARNESS_INSTALLS = 64;

// What an install reports as its version when the Collector found the install
// and could not read a version from it.
export const UNKNOWN_HARNESS_VERSION = 'unknown';

// One install of a Harness on a System: which Harness, the kind of place it
// was found in (such as `mise`, `npm`, `homebrew`, or `native`), and its
// version. Harness and location are any short word, and the version any short
// text, so a newer Collector's Harness, location, or version scheme does not
// reject a Report (ADR-0004). No path is sent.
const HarnessInstallSchema = z.object({
  harness: z.string().min(1).max(64),
  location: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
});

// A Report's harnesses section: every install of a Harness the Collector found,
// each read from files, never by running a Harness. A Harness that is not
// installed has none. A Collector sends it when its installs change, when it
// starts, and hourly; the Hub keeps the System's latest.
export const HarnessesSectionSchema = z.object({
  installs: z.array(HarnessInstallSchema).max(MAX_HARNESS_INSTALLS),
});

export type HarnessInstall = z.infer<typeof HarnessInstallSchema>;
export type HarnessesSection = z.infer<typeof HarnessesSectionSchema>;
