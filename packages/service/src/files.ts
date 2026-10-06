import { readFile } from 'node:fs/promises';

// True when `error` says the file is not there.
export const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

// The file's text, or undefined when there is no file.
export const readIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
};
