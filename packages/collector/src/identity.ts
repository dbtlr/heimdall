import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SYSTEM_NAME } from '@heimdall/schema';

import { describeError } from './errors.ts';
import { parseJson } from './json.ts';

// What the Hub answers a redeemed Pairing code with: the System's name and its
// new token. The token is a secret: nothing prints or logs it.
export type Pairing = { system: string; token: string };

// The System this Collector reports as, the token the Hub issued it when it
// paired (ADR-0009), and that Hub's origin, which binds the token to it.
export type SystemIdentity = Pairing & { hub: string };

const TOKEN = /^[A-Za-z0-9_-]+$/u;

// Where the Collector keeps its identity: `identity.json` in its state directory.
export const identityPath = (stateDir: string) => join(stateDir, 'identity.json');

// `value` as a Pairing, or undefined unless it holds a Fleet System name and a
// non-empty base64url token.
export const asPairing = (value: unknown): Pairing | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { system, token } = value as { system?: unknown; token?: unknown };
  return typeof system === 'string' &&
    SYSTEM_NAME.test(system) &&
    typeof token === 'string' &&
    TOKEN.test(token)
    ? { system, token }
    : undefined;
};

// Whether `hub` is an http or https origin as the URL parser writes one: a
// scheme, host, and port only.
const isOrigin = (hub: unknown): hub is string => {
  if (typeof hub !== 'string' || !URL.canParse(hub)) {
    return false;
  }
  const url = new URL(hub);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === hub;
};

// `value` as an identity, or undefined unless it holds a Pairing and the
// origin of the Hub that issued it.
export const asIdentity = (value: unknown): SystemIdentity | undefined => {
  const pairing = asPairing(value);
  const { hub } = (value ?? {}) as { hub?: unknown };
  return pairing !== undefined && isOrigin(hub) ? { ...pairing, hub } : undefined;
};

// What the state directory holds: an identity, with what keeps it from being
// private to its owner; none; or a file that is not one, with a problem that
// names the file and never its content.
export type IdentityRead =
  | { exposures: string[]; identity: SystemIdentity; kind: 'paired'; path: string }
  | { kind: 'not paired'; path: string }
  | { kind: 'invalid'; path: string; problem: string };

const GROUP_OR_OTHER = 0o077;
const GROUP_OR_OTHER_WRITE = 0o022;

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;

// What lets a user other than `uid` read or replace the identity: any group or
// other access to the file, a directory group or others can write to, or a
// file another user owns.
const exposuresOf = async ({
  file,
  path,
  stateDir,
  uid,
}: {
  file: { mode: number; uid: number };
  path: string;
  stateDir: string;
  uid: number | undefined;
}): Promise<string[]> => {
  const directory = await stat(stateDir);
  return [
    ...((file.mode & GROUP_OR_OTHER) === 0
      ? []
      : [`${path} has mode ${octal(file.mode)}; run chmod 600 ${path}`]),
    ...((directory.mode & GROUP_OR_OTHER_WRITE) === 0
      ? []
      : [
          `group or others can write to ${stateDir}, so they could replace the identity; run chmod go-w ${stateDir}`,
        ]),
    ...(uid === undefined || file.uid === uid
      ? []
      : [`${path} is owned by uid ${String(file.uid)}, not this user (uid ${String(uid)})`]),
  ];
};

// Reads the identity in `stateDir`, judging its privacy for the user `uid`.
export const readIdentity = async (
  stateDir: string,
  { uid = process.getuid?.() }: { uid?: number } = {},
): Promise<IdentityRead> => {
  const path = identityPath(stateDir);
  let text: string;
  let owner: { mode: number; uid: number };
  try {
    const file = await open(path, 'r');
    try {
      owner = await file.stat();
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'not paired', path };
    }
    return { kind: 'invalid', path, problem: `could not read ${path}: ${describeError(error)}` };
  }
  const identity = asIdentity(parseJson(text));
  if (identity === undefined) {
    return { kind: 'invalid', path, problem: `${path} does not hold a valid identity` };
  }
  return {
    exposures: await exposuresOf({ file: owner, path, stateDir, uid }),
    identity,
    kind: 'paired',
    path,
  };
};

// Flushes the directory entry a rename changed. Some platforms cannot sync a
// directory; the identity is in place either way, so a failure here is ignored.
const syncDirectory = async (dir: string) => {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: the rename already happened.
  }
};

// Writes `identity` to `identity.json` in `stateDir`, which must exist,
// replacing any identity there whole: a temporary file in the same directory,
// readable by its owner alone, is synced to disk and renamed over it, so a
// reader or a crash sees the old identity or the new one, never part of one.
export const writeIdentity = async (stateDir: string, identity: SystemIdentity): Promise<void> => {
  const temporary = join(stateDir, `.identity.json.${crypto.randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(identity)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, identityPath(stateDir));
  } catch (error) {
    // A failed cleanup must not hide why the write failed.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(stateDir);
};
