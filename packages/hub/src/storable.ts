// Text PostgreSQL can store: NUL and lone surrogates, which the Report schema
// allows, become U+FFFD. Refusing them would stall the Collector's queue.
export const storable = (text: string) => text.toWellFormed().replaceAll('\0', '�');

// JSON of `value` whose every string is storable, for a jsonb parameter.
export const storableJson = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === 'string' ? storable(v) : v));
