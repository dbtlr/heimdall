import { expect, test } from 'bun:test';

import { phoneTabOf, sectionOf, SECTIONS } from './sections.ts';
import type { PhoneTab, Section } from './sections.ts';

test('the top bar names six sections in order', () => {
  expect(SECTIONS.map(({ label }) => label)).toEqual([
    'Home',
    'Systems',
    'Services',
    'Agents',
    'Maintenance',
    'Activity',
  ]);
});

test('every route marks the section it belongs to, and the phone tab that holds it', () => {
  const cases: [string, Record<string, unknown>, Section | undefined, PhoneTab | undefined][] = [
    ['/', {}, 'home', 'home'],
    ['/compare', { range: '7d' }, 'home', 'home'],
    ['/systems', {}, 'systems', 'more'],
    ['/systems/', {}, 'systems', 'more'],
    ['/systems/server-1', { tab: 'vitals' }, 'systems', 'more'],
    ['/systems/server-1/conditions/12', {}, 'systems', 'more'],
    ['/systems/server-1/services/web', {}, 'services', 'services'],
    ['/systems/server-1/sessions/codex/codex/abc', {}, 'agents', 'agents'],
    ['/services', {}, 'services', 'services'],
    ['/services', { status: ['down'] }, 'services', 'services'],
    ['/services', { status: ['updates', 'down'] }, 'services', 'services'],
    ['/services', { status: ['updates'] }, 'maintenance', 'more'],
    ['/services', { status: 'updates', system: ['server-1'] }, 'maintenance', 'more'],
    ['/agents', { by: 'project' }, 'agents', 'agents'],
    ['/timeline', {}, 'activity', 'activity'],
    ['/more', {}, undefined, 'more'],
    ['/nowhere', {}, undefined, undefined],
  ];
  for (const [path, search, section, tab] of cases) {
    expect({ path, search, section: sectionOf(path, search) }).toEqual({ path, search, section });
    expect({ path, search, tab: phoneTabOf(path, search) }).toEqual({ path, search, tab });
  }
});
