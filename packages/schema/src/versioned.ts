import { z } from 'zod';

// What a reader makes of a versioned document. An unknown schema version is
// its own outcome, so the reader can say it is behind rather than that the
// document is broken.
export type VersionedParse<T> =
  | { kind: 'invalid'; reason: string }
  | { kind: 'parsed'; value: T }
  | { kind: 'unknown-version'; schemaVersion: number };

// The schema version an input claims, or undefined when it claims none a
// release could carry.
const claimedVersion = (input: unknown) => {
  const version = z.object({ schemaVersion: z.int().positive() }).safeParse(input);
  return version.success ? version.data.schemaVersion : undefined;
};

// A parser for documents of one schema version.
export const versionedParser =
  <T>(schema: z.ZodType<T>, version: number) =>
  (input: unknown): VersionedParse<T> => {
    const schemaVersion = claimedVersion(input);
    if (schemaVersion !== undefined && schemaVersion !== version) {
      return { kind: 'unknown-version', schemaVersion };
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return { kind: 'invalid', reason: z.prettifyError(parsed.error) };
    }
    return { kind: 'parsed', value: parsed.data };
  };
