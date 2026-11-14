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
  const cases: [string, Section | undefined, PhoneTab | undefined][] = [
    ['/', 'home', 'home'],
    ['/systems', 'systems', 'more'],
    ['/systems/', 'systems', 'more'],
    ['/systems/server-1', 'systems', 'more'],
    ['/systems/server-1/conditions/12', 'systems', 'more'],
    ['/systems/server-1/services/web', 'services', 'services'],
    ['/systems/server-1/sessions/codex/codex/abc', 'agents', 'agents'],
    ['/services', 'services', 'services'],
    ['/maintenance', 'maintenance', 'more'],
    ['/agents', 'agents', 'agents'],
    ['/activity', 'activity', 'activity'],
    ['/more', undefined, 'more'],
    ['/nowhere', undefined, undefined],
  ];
  for (const [path, section, tab] of cases) {
    expect({ path, section: sectionOf(path) }).toEqual({ path, section });
    expect({ path, tab: phoneTabOf(path) }).toEqual({ path, tab });
  }
});
