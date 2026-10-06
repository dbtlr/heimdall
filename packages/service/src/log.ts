// `message` as a log line: its ISO 8601 UTC time first, so every line in a
// supervisor's log says when it was written and the log's age can be read.
export const timestamped = (message: string, now: number): string =>
  `${new Date(now).toISOString()} ${message}`;

// Where `serve` and `run` write their runtime lines. Command output, such as
// `service status` or a help page, does not go through it.
export type RuntimeLog = {
  fatal: (message: string) => never;
  info: (message: string) => Promise<void>;
  warn: (message: string) => Promise<void>;
};

// A runtime log over `print`, which writes one line: the action's `out.print`,
// and `fatal`, which ends the run with a line: the action's `out.fatal`, whose
// exit code and stderr placement stay as they are.
// The supervisor appends stdout and stderr to the same file, and Loom's lanes
// put a glyph ahead of anything written to stderr, so the lines go to stdout
// with the timestamp first and a warning marked in words.
export const runtimeLog = ({
  fatal,
  now = Date.now,
  print,
}: {
  fatal: (line: string) => never;
  now?: () => number;
  print: (line: string) => Promise<void>;
}): RuntimeLog => ({
  fatal: (message) => fatal(timestamped(message, now())),
  info: (message) => print(timestamped(message, now())),
  warn: (message) => print(timestamped(`warning: ${message}`, now())),
});
