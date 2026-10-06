// The message of a thrown value, for a log line.
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
