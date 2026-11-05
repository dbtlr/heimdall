import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { readIfPresent } from './files.ts';

// Where the command runs: the home folder and the environment Loom resolves XDG from.
export type Place = { env: Readonly<Record<string, string | undefined>>; home: string };

const TABLE_HEADER = /^\s*\[/u;
const PORT_LINE = /^\s*port\s*=/u;

const parseToml = (text: string): Record<string, unknown> => {
  try {
    return Object.fromEntries(Object.entries(Bun.TOML.parse(text)));
  } catch (error) {
    throw new Error(
      `The file is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

// A port written as a number or as a string of its digits: the Hub reads both.
const samePort = (value: unknown, port: number) =>
  (typeof value === 'number' || typeof value === 'string') && Number(value) === port;

const withoutPort = (settings: Record<string, unknown>) => {
  const { port: _, ...rest } = settings;
  return rest;
};

// `text`, a TOML configuration file, with its top-level `port` set to `port`, or
// undefined when it already holds that value. An existing top-level `port` line
// is replaced; otherwise the key goes after the last top-level line, ahead of
// any table. The result must parse to the same settings with the new port, or
// the edit is refused rather than written.
export const withPort = (text: string, port: number): string | undefined => {
  const settings = parseToml(text);
  if (samePort(settings.port, port)) {
    return undefined;
  }
  const line = `port = ${String(port)}`;
  const lines = text.split('\n');
  const tableAt = lines.findIndex((each) => TABLE_HEADER.test(each));
  const topLevel = tableAt === -1 ? lines.length : tableAt;
  const portAt = lines.slice(0, topLevel).findIndex((each) => PORT_LINE.test(each));
  if (portAt === -1) {
    const lastContent = lines.slice(0, topLevel).findLastIndex((each) => each.trim() !== '');
    const insertAt = lastContent + 1;
    // A key straight above a table header gets a blank line between them.
    const added = insertAt === tableAt ? [line, ''] : [line];
    lines.splice(insertAt, 0, ...added);
  } else {
    lines[portAt] = line;
  }
  const edited = lines.join('\n');
  const check = parseToml(edited);
  if (check.port !== port || !Bun.deepEquals(withoutPort(check), withoutPort(settings))) {
    throw new Error(`Could not set the port in this file. Set ${line} in it by hand.`);
  }
  return edited;
};

// The folder Loom keeps a binary's user-level configuration in: heimdall-<binary>
// under XDG_CONFIG_HOME when that is absolute and non-empty, else under
// <home>/.config.
const xdgFolder = (binary: string, place: Place) => {
  const xdg = place.env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(place.home, '.config');
  return join(base, `heimdall-${binary}`);
};

// A file Loom would read after `file`, if one is there: a new `file` ahead of it
// would hide it. The same-name JSON file comes first, then the XDG user file.
const fileThatWouldBeHidden = async (file: string, place: Place) => {
  const binary = basename(file, '.toml');
  const json = file.replace(/\.toml$/u, '.json');
  const folder = xdgFolder(binary, place);
  const candidates = [json, join(folder, 'config.toml'), join(folder, 'config.json')];
  const present = await Promise.all(
    candidates.map(async (candidate) => candidate !== file && (await Bun.file(candidate).exists())),
  );
  return candidates.find((_, index) => present[index]);
};

// Sets `port` in the configuration file at `file` and reports whether it wrote.
// A file that already holds the value is left exactly as it is, so a file Fleet
// rendered stays as Fleet rendered it. A missing file is created, readable by
// its owner alone because the Hub's file also holds its database URL, which may
// carry a password, unless a JSON file of the same name or the XDG user file
// holds the settings instead.
export const setPort = async (file: string, port: number, place: Place): Promise<boolean> => {
  const existing = await readIfPresent(file);
  // Loom reads the first file it finds: hub.toml, hub.json, then the XDG user
  // file, so a new TOML file holding only the port would hide every setting in
  // the later ones.
  const hidden = existing === undefined ? await fileThatWouldBeHidden(file, place) : undefined;
  if (hidden !== undefined) {
    throw new Error(
      `${hidden} holds the settings, and a new ${basename(file)} would hide them. Set port to ${String(port)} in ${hidden} instead, or move its settings to ${basename(file)}.`,
    );
  }
  const edited = withPort(existing ?? '', port);
  if (edited === undefined) {
    return false;
  }
  if (existing === undefined) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, edited, { mode: 0o600 });
  } else {
    await writeFile(file, edited);
  }
  return true;
};
