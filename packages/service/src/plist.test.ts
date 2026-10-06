import { expect, test } from 'bun:test';

import { launchdPlistPath, serviceDefinition } from './names.ts';
import type { ServiceDefinition } from './names.ts';
import { renderLaunchdPlist } from './plist.ts';

const HOME = '/Users/operator';

const collector = (executable = '/opt/heimdall/bin/heimdall-collector', home = HOME) =>
  serviceDefinition({ binary: 'collector', executable, home });

test('a launchd user agent lives in LaunchAgents under home, named by its label', () => {
  expect(launchdPlistPath(HOME, 'com.dbtlr.heimdall.collector')).toBe(
    '/Users/operator/Library/LaunchAgents/com.dbtlr.heimdall.collector.plist',
  );
});

test('the Collector agent runs plain run from home, keeps it alive, and appends to the log', () => {
  expect(renderLaunchdPlist(collector())).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dbtlr.heimdall.collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/heimdall/bin/heimdall-collector</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/operator</string>
  <key>StandardOutPath</key>
  <string>/Users/operator/.local/state/heimdall/collector.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/operator/.local/state/heimdall/collector.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`);
});

test('the Hub agent runs plain serve and sets no environment', () => {
  const plist = renderLaunchdPlist(
    serviceDefinition({ binary: 'hub', executable: '/opt/heimdall/bin/heimdall-hub', home: HOME }),
  );

  expect(plist).toContain(`  <array>
    <string>/opt/heimdall/bin/heimdall-hub</string>
    <string>serve</string>
  </array>`);
  expect(plist).not.toContain('EnvironmentVariables');
});

test('markup characters in a path are escaped, so the path reads back unchanged', () => {
  const plist = renderLaunchdPlist(
    collector(`/opt/R&D <tools>/"quoted" 'bin'/heimdall-collector`, '/Users/a&b'),
  );

  expect(plist).toContain(
    '<string>/opt/R&amp;D &lt;tools&gt;/&quot;quoted&quot; &apos;bin&apos;/heimdall-collector</string>',
  );
  expect(plist).toContain('<string>/Users/a&amp;b</string>');
  expect(plist).toContain('<string>/Users/a&amp;b/.local/state/heimdall/collector.log</string>');
});

test('a carriage return in a path survives as a character reference', () => {
  expect(renderLaunchdPlist(collector('/opt/odd\rname/heimdall-collector'))).toContain(
    '<string>/opt/odd&#13;name/heimdall-collector</string>',
  );
});

test.each([
  ['a NUL', '/opt/heimdall\0/heimdall-collector'],
  ['an escape character', '/opt/heimdall\u001B[31m/heimdall-collector'],
  ['a vertical tab', '/opt/heimdall\v/heimdall-collector'],
  ['a noncharacter', '/opt/heimdall￿/heimdall-collector'],
  ['a lone surrogate', '/opt/heimdall\uD800/heimdall-collector'],
])('a path holding %s, which XML cannot carry, is refused', (_name, executable) => {
  expect(() => renderLaunchdPlist(collector(executable))).toThrow('cannot carry');
});

test('a label with a markup character is escaped like any other value', () => {
  const definition: ServiceDefinition = { ...collector(), label: 'com.example.a<b' };

  expect(renderLaunchdPlist(definition)).toContain('<string>com.example.a&lt;b</string>');
});
