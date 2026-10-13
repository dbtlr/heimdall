import { describe, expect, test } from 'bun:test';

import {
  NO_GUI_DOMAIN,
  NOT_FOUND_IN_GUI,
  NOT_FOUND_IN_SYSTEM,
  NOT_FOUND_IN_USER_DOMAIN,
  NOT_RUNNING_AGENT,
  RUNNING_AGENT,
  SYSTEM_DAEMON,
} from './launchctl-captures.ts';
import { isDomainMissing, isServiceNotLoaded, readPrintedService } from './launchctl.ts';

const result = (code: number, stderr = '', stdout = '') => ({ code, stderr, stdout });

describe('a service launchctl does not have loaded', () => {
  test.each([
    ['the GUI domain', NOT_FOUND_IN_GUI],
    ['the system domain', NOT_FOUND_IN_SYSTEM],
    ['the user domain', NOT_FOUND_IN_USER_DOMAIN],
  ])('is exit 113 with launchctl saying it could not find the service in %s', (_name, said) => {
    expect(isServiceNotLoaded(result(113, said))).toBe(true);
  });

  test('is recognized from stdout, and whatever the case', () => {
    expect(isServiceNotLoaded(result(113, '', 'COULD NOT FIND SERVICE "x"'))).toBe(true);
    expect(isServiceNotLoaded(result(113, 'could not find service "x"'))).toBe(true);
  });

  test.each([
    ['another exit code with the message', result(1, 'Could not find service "x"')],
    ['exit 3 with the message', result(3, 'Could not find service "x"')],
    ['exit 112 for a domain', result(112, NO_GUI_DOMAIN)],
    ['exit 113 with no message', result(113)],
    ['success', result(0, '', 'Could not find service')],
  ])('is not exit %s', (_name, answer) => {
    expect(isServiceNotLoaded(answer)).toBe(false);
  });
});

describe('a domain launchctl does not have', () => {
  test('is exit 112 with launchctl saying it could not find the domain', () => {
    expect(isDomainMissing(result(112, NO_GUI_DOMAIN))).toBe(true);
  });

  test('is recognized from stdout, and whatever the case', () => {
    expect(isDomainMissing(result(112, '', 'could not find domain for user gui: 501'))).toBe(true);
    expect(isDomainMissing(result(112, 'COULD NOT FIND DOMAIN'))).toBe(true);
  });

  test.each([
    ['exit 113 with the message', result(113, NO_GUI_DOMAIN)],
    ['exit 3 with the message', result(3, NO_GUI_DOMAIN)],
    ['exit 112 with no message', result(112)],
    ['exit 112 for a service', result(112, NOT_FOUND_IN_GUI)],
    ['success', result(0, '', 'Could not find domain')],
  ])('is not %s', (_name, answer) => {
    expect(isDomainMissing(answer)).toBe(false);
  });
});

// A service with only the lines a test is about, for the cases a capture does not cover.
const printed = (lines: string[]) => `gui/501/x = {\n${lines.join('\n')}\n}\n`;

describe('a printed service', () => {
  test('is running, with its pid, as launchctl prints a running agent', () => {
    expect(readPrintedService(RUNNING_AGENT)).toEqual({
      exitCode: '143',
      pid: 59_099,
      running: true,
      signal: undefined,
      state: 'running',
    });
  });

  test('is not running as launchctl prints a loaded agent with no process', () => {
    expect(readPrintedService(NOT_RUNNING_AGENT)).toEqual({
      exitCode: '0',
      pid: undefined,
      running: false,
      signal: undefined,
      state: 'not running',
    });
  });

  test('is readable for a system daemon, which launchctl prints without root', () => {
    expect(readPrintedService(SYSTEM_DAEMON)).toMatchObject({
      exitCode: '(never exited)',
      pid: 165,
      running: true,
    });
  });

  test('is running when its own state says running, with the pid when printed', () => {
    expect(readPrintedService(printed(['\tstate = running', '\tpid = 4182']))).toMatchObject({
      pid: 4182,
      running: true,
      state: 'running',
    });
  });

  test('is running when its state says running, with no pid printed', () => {
    const service = readPrintedService(printed(['\tstate = running']));

    expect(service.running).toBe(true);
    expect(service.pid).toBeUndefined();
  });

  test('is running when a pid is printed, whatever its state says', () => {
    expect(readPrintedService(printed(['\tstate = xpc proxy', '\tpid = 4182']))).toMatchObject({
      pid: 4182,
      running: true,
      state: 'xpc proxy',
    });
  });

  test('is not running without a state of running or a pid made of digits', () => {
    const service = readPrintedService(printed(['\tstate = not running', '\tpid = (none)']));

    expect(service).toMatchObject({ running: false, state: 'not running' });
    expect(service.pid).toBeUndefined();
  });

  test('does not count a pid that only starts with digits', () => {
    expect(readPrintedService(printed(['\tstate = not running', '\tpid = 12abc'])).running).toBe(
      false,
    );
  });

  test('reads the exit code and terminating signal of the service, not of a block in it', () => {
    // The captured coalition blocks, given a state, pid, and exit code of their own.
    const nested = NOT_RUNNING_AGENT.replaceAll(
      '\t\tstate = active\n',
      '\t\tstate = running\n\t\tpid = 1\n\t\tlast exit code = 99\n',
    ).replace(
      '\tlast exit code = 0\n',
      '\tlast exit code = 78\n\tlast terminating signal = Killed: 9\n',
    );

    expect(readPrintedService(nested)).toEqual({
      exitCode: '78',
      pid: undefined,
      running: false,
      signal: 'Killed: 9',
      state: 'not running',
    });
  });

  test('has no state when the value is only whitespace or the line is missing', () => {
    expect(readPrintedService(printed(['\tstate =    ']))).toMatchObject({ running: false });
    expect(readPrintedService(printed(['\tstate =    '])).state).toBeUndefined();
    expect(readPrintedService(printed([])).state).toBeUndefined();
  });
});
