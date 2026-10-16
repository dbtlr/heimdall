import { storableText } from '@heimdall/schema';

// Text PostgreSQL can store: NUL and lone surrogates, which the Report schema
// and transcripts allow, become U+FFFD. Refusing them would stall the
// Collector's queue, or the projection of a transcript.
export const storable = storableText;

// JSON of `value` whose every string is storable, for a jsonb parameter.
export const storableJson = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === 'string' ? storable(v) : v));
