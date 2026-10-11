// Text PostgreSQL can store: NUL and lone surrogates, which the Report schema
// and transcripts allow, become U+FFFD. Refusing them would stall the
// Collector's queue, or the projection of a transcript.
export const storable = (text: string) => text.toWellFormed().replaceAll('\0', '�');

// `value` as JSON whose every string is storable.
export const storableJson = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === 'string' ? storable(v) : v));
