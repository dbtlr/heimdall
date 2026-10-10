import { describe, expect, test } from 'bun:test';

import { isServiceNotLoaded, readPrintedService } from './launchctl.ts';

const result = (code: number, stderr = '', stdout = '') => ({ code, stderr, stdout });

describe('a service launchctl does not have loaded', () => {
  test('is exit 113 with launchctl saying it could not find the service', () => {
    expect(
      isServiceNotLoaded(
        result(113, 'Bad request.\nCould not find service "x" in domain for system\n'),
      ),
    ).toBe(true);
  });

  test('is recognized from stdout, and whatever the case', () => {
    expect(isServiceNotLoaded(result(113, '', 'COULD NOT FIND SERVICE "x"'))).toBe(true);
    expect(isServiceNotLoaded(result(113, 'could not find service "x"'))).toBe(true);
  });

  test.each([
    ['another exit code with the message', result(1, 'Could not find service "x"')],
    ['exit 3 with the message', result(3, 'Could not find service "x"')],
    ['exit 113 for a domain', result(113, 'Could not find domain for user gui: 501')],
    ['exit 113 with no message', result(113)],
    ['success', result(0, '', 'Could not find service')],
  ])('is not exit %s', (_name, answer) => {
    expect(isServiceNotLoaded(answer)).toBe(false);
  });
});

const printed = (lines: string[]) => `gui/501/x = {\n${lines.join('\n')}\n}\n`;

describe('a printed service', () => {
  test('is running when its own state says running, with the pid when printed', () => {
    expect(readPrintedService(printed(['\tstate = running', '\tpid = 4182']))).toMatchObject({
      pid: 4182,
      running: true,
      state: 'running',
    });
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

  test('reads the exit code and terminating signal of the service, not of a block in it', () => {
    const service = readPrintedService(
      printed([
        '\tstate = not running',
        '\tjetsam coalition = {',
        '\t\tlast exit code = 99',
        '\t\tstate = running',
        '\t\tpid = 1',
        '\t}',
        '\tlast exit code = 78',
        '\tlast terminating signal = Killed: 9',
      ]),
    );

    expect(service).toEqual({
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
