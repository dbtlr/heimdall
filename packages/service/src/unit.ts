import type { ServiceDefinition } from './names.ts';

// A line break would end the directive and start another, and systemd cannot
// read a NUL byte, so both are refused.
const singleLine = (value: string) => {
  if (/[\r\n\0]/u.test(value)) {
    throw new Error(`A unit file value cannot hold a line break or NUL: ${JSON.stringify(value)}`);
  }
  return value;
};

// Every unit-file value doubles `%`, which would otherwise start a specifier.
const plain = (value: string) => singleLine(value).replaceAll('%', '%%');

// An `ExecStart` word: double-quoted, with quotes and backslashes escaped and
// `$` doubled so systemd expands no variable.
const execWord = (value: string) =>
  `"${plain(value)
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('$', '$$$$')}"`;

// The systemd user unit for a Service. It restarts the binary 10 seconds after
// any exit and never gives up, starts with the user manager, and appends both
// output streams to the log, which the binary rotates itself. Loom exits 143
// after SIGTERM and 130 after SIGINT, so those count as a clean stop.
export const renderSystemdUnit = (definition: ServiceDefinition): string => {
  const log = plain(definition.log);
  // The arguments are fixed command names, so only the executable needs quoting.
  const command = [execWord(definition.executable), ...definition.arguments.map(plain)].join(' ');
  return `[Unit]
Description=${plain(definition.description)}
StartLimitIntervalSec=0

[Service]
ExecStart=${command}
WorkingDirectory=${plain(definition.workingDirectory)}
StandardOutput=append:${log}
StandardError=append:${log}
Restart=always
RestartSec=10
SuccessExitStatus=130 143

[Install]
WantedBy=default.target
`;
};
