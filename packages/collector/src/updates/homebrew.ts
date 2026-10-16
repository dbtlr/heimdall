/* oxlint-disable no-await-in-loop -- Bound file descriptors and memory while scanning local package receipts sequentially. */
import { constants, verify } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { UpdateManager } from '@heimdall/schema';

import { describeError } from '../errors.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const read = async (path: string, maxBytes = 1024 * 1024) => {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size > maxBytes) {
      throw new Error('Homebrew cache exceeds read budget');
    }
    const bytes = Buffer.alloc(size + 1);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > size) {
      throw new Error('Homebrew cache changed during read');
    }
    return bytes.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
};
const directories = async (path: string, absentIsEmpty = false) => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    if (
      entries.some(
        (entry) => entry.isSymbolicLink() || (!entry.name.startsWith('.') && !entry.isDirectory()),
      )
    ) {
      throw new Error('Homebrew census contains an unsupported entry');
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (error) {
    if (
      absentIsEmpty &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
};

// Homebrew's API uses detached, unencoded PS512 payloads, not ordinary
// base64-encoded JWS. Reading and verifying the envelopes avoids brew's lazy
// network fallback for missing, corrupt, or stale cache entries.
// https://github.com/Homebrew/brew/blob/main/Library/Homebrew/api.rb
const metadata = async (path: string, key: string) => {
  const envelope: unknown = JSON.parse(await read(path, 64 * 1024 * 1024));
  if (
    !object(envelope) ||
    typeof envelope.payload !== 'string' ||
    !Array.isArray(envelope.signatures)
  ) {
    throw new Error('invalid Homebrew signed cache');
  }
  const signature: unknown = envelope.signatures.find(
    (entry: unknown) => object(entry) && object(entry.header) && entry.header.kid === 'homebrew-1',
  );
  if (
    !object(signature) ||
    typeof signature.protected !== 'string' ||
    typeof signature.signature !== 'string'
  ) {
    throw new Error('missing Homebrew cache signature');
  }
  const header: unknown = JSON.parse(
    Buffer.from(signature.protected, 'base64url').toString('utf8'),
  );
  if (!object(header) || header.alg !== 'PS512' || header.b64 !== false) {
    throw new Error('unsupported Homebrew cache signature');
  }
  if (
    !verify(
      'sha512',
      Buffer.from(`${signature.protected}.${envelope.payload}`),
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 },
      Buffer.from(signature.signature, 'base64url'),
    )
  ) {
    throw new Error('invalid Homebrew cache signature');
  }
  const rows: unknown = JSON.parse(envelope.payload);
  if (!Array.isArray(rows) || !rows.every(object)) {
    throw new Error('invalid Homebrew package metadata');
  }
  return rows;
};

// Restrict comparisons to Homebrew's straightforward numeric versions. HEAD,
// latest, prereleases, and version schemes need Homebrew semantics we have not
// verified, so they produce unavailable coverage rather than guessed updates.
const compare = (installed: string, available: string) => {
  if (installed === available) {
    return 0;
  }
  if (!/^\d+(?:\.\d+)*(?:_\d+)?$/.test(installed) || !/^\d+(?:\.\d+)*(?:_\d+)?$/.test(available)) {
    throw new Error('Homebrew version comparison is unsupported');
  }
  const left = installed.split('_');
  const right = available.split('_');
  const leftMain = (left[0] ?? '').split('.').map(BigInt);
  const rightMain = (right[0] ?? '').split('.').map(BigInt);
  for (let i = 0; i < Math.max(leftMain.length, rightMain.length); i++) {
    const a = leftMain[i] ?? 0n;
    const b = rightMain[i] ?? 0n;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  const a = BigInt(left[1] ?? '0');
  const b = BigInt(right[1] ?? '0');
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

// Only a comparable set of local receipt versions can establish which keg is
// newest. Unsupported versions preserve presence without claiming completion.
const newestVersion = (versions: string[]) => {
  let newest: string | undefined;
  for (const version of versions) {
    compare(version, '0');
    if (newest === undefined || compare(newest, version) < 0) {
      newest = version;
    }
  }
  return newest;
};

export const observeHomebrew = async ({
  prefix,
  cacheDir,
  observedAt,
}: {
  prefix: string;
  cacheDir: string;
  observedAt: number;
}): Promise<UpdateManager> => {
  const manager: UpdateManager = {
    installation: prefix,
    manager: 'homebrew',
    observedAt,
    result: { kind: 'unavailable', reason: 'Homebrew observation incomplete' },
  };
  try {
    const executable = await realpath(join(prefix, 'bin/brew'));
    const [owner, installationOwner] = await Promise.all([stat(executable), stat(prefix)]);
    if (owner.uid !== process.getuid?.() || installationOwner.uid !== process.getuid?.()) {
      throw new Error('Homebrew installation belongs to another account');
    }
    const installed: {
      kind: 'formula' | 'cask';
      name: string;
      confirmedVersion: string | undefined;
    }[] = [];
    for (const kind of ['formula', 'cask'] as const) {
      const root = join(prefix, kind === 'formula' ? 'Cellar' : 'Caskroom');
      const names = await directories(root, true);
      for (const name of names) {
        const versions = await directories(join(root, name));
        if (versions.length === 0) {
          throw new Error('Homebrew installation has no readable versions');
        }
        if (kind === 'formula') {
          for (const version of versions) {
            const receipt: unknown = JSON.parse(
              await read(join(root, name, version, 'INSTALL_RECEIPT.json')),
            );
            if (
              !object(receipt) ||
              !object(receipt.source) ||
              receipt.source.tap !== 'homebrew/core'
            ) {
              throw new Error('Homebrew third-party or unreadable receipt is unsupported');
            }
          }
        }
        if (kind === 'cask') {
          // Homebrew saves the originating tap in timestamped JSON receipts.
          // Ruby-only receipts cannot be safely interpreted without executing code.
          for (const version of versions) {
            const versionPath = join(root, name, '.metadata', version);
            const stamps = await directories(versionPath);
            const stamp = stamps.toSorted().at(-1);
            if (stamp === undefined) {
              throw new Error('Homebrew cask receipt is missing');
            }
            const receipt: unknown = JSON.parse(
              await read(join(versionPath, stamp, 'Casks', `${name}.json`)),
            );
            if (
              !object(receipt) ||
              receipt.tap !== 'homebrew/cask' ||
              receipt.token !== name ||
              receipt.version !== version
            ) {
              throw new Error('Homebrew cask receipt provenance is unsupported');
            }
          }
        }
        let confirmedVersion: string | undefined;
        try {
          confirmedVersion = newestVersion(versions);
        } catch {
          /* Unknown version semantics cannot prove an update was applied. */
        }
        installed.push({ confirmedVersion, kind, name });
      }
    }
    // Complete identity census is independent of whether signed repository
    // metadata is available, and never contains a partially scanned install.
    manager.installed = {
      names: installed.map(({ kind, name }) => `${kind}:${name}`),
      observedAt,
      versions: installed.flatMap(({ confirmedVersion, kind, name }) =>
        confirmedVersion === undefined
          ? []
          : [{ name: `${kind}:${name}`, version: confirmedVersion }],
      ),
    };
    const repository = dirname(dirname(executable));
    const key = await read(join(repository, 'Library/Homebrew/api/homebrew-1.pem'));
    const updates: Extract<UpdateManager['result'], { kind: 'available' }>['updates'] = [];
    const timestamps: number[] = [];
    for (const kind of ['formula', 'cask'] as const) {
      const packages = installed.filter((entry) => entry.kind === kind);
      if (packages.length === 0 && kind === 'cask') {
        continue;
      }
      const path = join(cacheDir, `${kind}.jws.json`);
      const rows = await metadata(path, key);
      timestamps.push((await stat(path)).mtimeMs);
      for (const entry of packages) {
        const row = rows.find((item) => item[kind === 'formula' ? 'name' : 'token'] === entry.name);
        if (
          row === undefined ||
          (kind === 'formula' && (row.tap !== 'homebrew/core' || row.version_scheme !== 0))
        ) {
          throw new Error('Homebrew local package metadata is unsupported or missing');
        }
        const version =
          kind === 'formula' && object(row.versions) ? row.versions.stable : row.version;
        if (
          typeof version !== 'string' ||
          (kind === 'formula' &&
            (!Number.isSafeInteger(row.revision) ||
              typeof row.revision !== 'number' ||
              row.revision < 0))
        ) {
          throw new Error('Homebrew available version is unknown');
        }
        const available =
          kind === 'formula' && row.revision !== 0 ? `${version}_${String(row.revision)}` : version;
        const newest = entry.confirmedVersion;
        if (newest === undefined) {
          throw new Error('Homebrew installed version comparison is unsupported');
        }
        if (compare(newest, available) < 0) {
          updates.push({
            available,
            installed: newest,
            name: `${kind}:${entry.name}`,
            security: null,
          });
        }
      }
    }
    const timestamp = Math.trunc(Math.min(...timestamps));
    manager.result = {
      kind: 'available',
      metadataAt:
        Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= observedAt ? timestamp : null,
      updates,
    };
  } catch (error) {
    manager.result = { kind: 'unavailable', reason: describeError(error).slice(0, 1024) };
  }
  return manager;
};
