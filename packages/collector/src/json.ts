// `text` parsed as JSON, or undefined when it is not JSON. The parser's message
// is dropped: it can quote the text, which may hold a secret.
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
