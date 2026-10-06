import { expect, test } from 'bun:test';

import { serviceDefinition, servicePaths, systemdUnitPath } from './names.ts';
import { renderSystemdUnit } from './unit.ts';

const HOME = '/home/operator';

test('each binary has its own label, log, and config file under home', () => {
  expect(servicePaths('hub', HOME)).toEqual({
    config: '/home/operator/.config/heimdall/hub.toml',
    label: 'com.dbtlr.heimdall.hub',
    log: '/home/operator/.local/state/heimdall/hub.log',
  });
  expect(servicePaths('collector', HOME)).toEqual({
    config: '/home/operator/.config/heimdall/collector.toml',
    label: 'com.dbtlr.heimdall.collector',
    log: '/home/operator/.local/state/heimdall/collector.log',
  });
});

test('a systemd user unit lives in the user manager search path under home', () => {
  expect(systemdUnitPath(HOME, 'com.dbtlr.heimdall.hub')).toBe(
    '/home/operator/.config/systemd/user/com.dbtlr.heimdall.hub.service',
  );
});

test('the Hub unit runs plain serve from home and appends its output to the log', () => {
  const unit = renderSystemdUnit(
    serviceDefinition({ binary: 'hub', executable: '/opt/heimdall/bin/heimdall-hub', home: HOME }),
  );

  expect(unit).toBe(`[Unit]
Description=Heimdall Hub (com.dbtlr.heimdall.hub)
StartLimitIntervalSec=0

[Service]
ExecStart="/opt/heimdall/bin/heimdall-hub" serve
WorkingDirectory=/home/operator
StandardOutput=append:/home/operator/.local/state/heimdall/hub.log
StandardError=append:/home/operator/.local/state/heimdall/hub.log
Restart=always
RestartSec=10
SuccessExitStatus=130 143

[Install]
WantedBy=default.target
`);
});

test('the Collector unit runs plain run and carries no environment', () => {
  const unit = renderSystemdUnit(
    serviceDefinition({
      binary: 'collector',
      executable: '/opt/heimdall/bin/heimdall-collector',
      home: HOME,
    }),
  );

  expect(unit).toContain('Description=Heimdall Collector (com.dbtlr.heimdall.collector)\n');
  expect(unit).toContain('ExecStart="/opt/heimdall/bin/heimdall-collector" run\n');
  expect(unit).toContain(
    'StandardOutput=append:/home/operator/.local/state/heimdall/collector.log\n',
  );
  expect(unit).not.toContain('Environment');
});

test('unit values escape specifiers, variables, quotes, and backslashes', () => {
  const unit = renderSystemdUnit(
    serviceDefinition({ binary: 'hub', executable: '/opt/100%/$HOME/"q"\\b', home: '/home/50%' }),
  );

  expect(unit).toContain(String.raw`ExecStart="/opt/100%%/$$HOME/\"q\"\\b" serve`);
  expect(unit).toContain('WorkingDirectory=/home/50%%\n');
  expect(unit).toContain('StandardOutput=append:/home/50%%/.local/state/heimdall/hub.log\n');
});

test('a path with a line break is refused rather than written into the unit', () => {
  expect(() =>
    renderSystemdUnit(
      serviceDefinition({
        binary: 'hub',
        executable: '/opt/x\nExecStartPre=/bin/evil',
        home: HOME,
      }),
    ),
  ).toThrow('line break');
});

test('a path with a NUL byte is refused rather than written into the unit', () => {
  expect(() =>
    renderSystemdUnit(serviceDefinition({ binary: 'hub', executable: '/opt/x\0y', home: HOME })),
  ).toThrow('NUL');
});

test('a binary stopped by SIGTERM or SIGINT exits cleanly in the unit', () => {
  const unit = renderSystemdUnit(
    serviceDefinition({ binary: 'collector', executable: '/opt/heimdall-collector', home: HOME }),
  );

  // Loom exits 143 after SIGTERM and 130 after SIGINT; a stop must read stopped, not failed.
  expect(unit).toContain('\nSuccessExitStatus=130 143\n');
});
