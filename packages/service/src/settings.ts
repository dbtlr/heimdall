import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { readIfPresent } from './files.ts';

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

// Sets `port` in the configuration file at `file` and reports whether it wrote.
// A file that already holds the value is left exactly as it is, so a file Fleet
// rendered stays as Fleet rendered it. A missing file is created, readable by
// its owner alone because the Hub's file also holds its tokens, unless a JSON
// file of the same name holds the settings instead.
export const setPort = async (file: string, port: number): Promise<boolean> => {
  const existing = await readIfPresent(file);
  // Loom reads the first of hub.toml and hub.json it finds, so a new TOML file
  // holding only the port would hide every setting in the JSON one.
  const json = file.replace(/\.toml$/u, '.json');
  if (existing === undefined && json !== file && (await Bun.file(json).exists())) {
    throw new Error(
      `${basename(json)} holds the settings, and a new ${basename(file)} would hide them. Set "port": ${String(port)} in ${json} instead, or move its settings to ${basename(file)}.`,
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
