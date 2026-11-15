// `text` cut to at most `max` characters, ending with `…` when cut, so text a
// Collector sent cannot make a log line or a stored reason unbounded.
export const shortened = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
