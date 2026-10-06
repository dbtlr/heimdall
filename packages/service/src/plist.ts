import type { ServiceDefinition } from './names.ts';

// Tab, line feed, and carriage return, the C0 controls XML 1.0 carries.
const ALLOWED_CONTROLS = new Set([9, 10, 13]);
// U+FFFE and U+FFFF, which XML 1.0 excludes.
const NONCHARACTERS = new Set([65_534, 65_535]);

// True for a UTF-16 code unit XML 1.0 cannot carry, even as a character reference.
const uncarriable = (code: number) =>
  (code < 32 && !ALLOWED_CONTROLS.has(code)) || NONCHARACTERS.has(code);

// True when XML can carry every character of `value`. A lone surrogate is
// not a character at all.
const carriable = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    if (uncarriable(value.charCodeAt(index))) {
      return false;
    }
  }
  return value.isWellFormed();
};

// A plist `<string>` body. Markup characters become entities, and a carriage
// return a character reference, which a parser would otherwise turn into a
// line feed. Anything XML cannot carry is refused.
const xmlText = (value: string) => {
  if (!carriable(value)) {
    throw new Error(`A property list cannot carry this value: ${JSON.stringify(value)}`);
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\r', '&#13;');
};

const string = (value: string) => `<string>${xmlText(value)}</string>`;

// The launchd user agent for a Service. launchd starts it at load and at each
// login, relaunches it after any exit no sooner than 10 seconds apart (as
// systemd's RestartSec=10 does), runs it from home rather than launchd's
// default of `/`, and appends both output streams to the log, which the binary
// rotates itself. It sets no environment: settings live in the config file.
export const renderLaunchdPlist = (definition: ServiceDefinition): string => {
  const log = string(definition.log);
  const program = [definition.executable, ...definition.arguments]
    .map((word) => `    ${string(word)}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(definition.label)}
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>WorkingDirectory</key>
  ${string(definition.workingDirectory)}
  <key>StandardOutPath</key>
  ${log}
  <key>StandardErrorPath</key>
  ${log}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
};
