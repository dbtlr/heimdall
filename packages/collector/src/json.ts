// `text` parsed as JSON, or undefined when it is not JSON. The parser's message
// is dropped: it can quote the text, which may hold a secret.
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Whether `value` is a table: an object that is not a list.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
