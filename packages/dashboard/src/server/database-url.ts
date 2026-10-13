import { join } from 'node:path';

type Env = Record<string, string | undefined>;

// Where the Hub's config file lives: under XDG_CONFIG_HOME when set, else
// $HOME/.config, the same place the Hub reads it from.
const hubConfigPath = (env: Env) => {
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config');
  return join(base, 'heimdall', 'hub.toml');
};

// The URL of the Hub's database: HEIMDALL_DATABASE_URL when set, else
// `[database] url` in the Hub's config file. The dashboard runs on the Hub's
// System and reads the Hub's database with the Hub's own role.
export const databaseUrl = async (env: Env = process.env): Promise<string> => {
  if (env.HEIMDALL_DATABASE_URL) {
    return env.HEIMDALL_DATABASE_URL;
  }
  const path = hubConfigPath(env);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`No database URL: set HEIMDALL_DATABASE_URL or write ${path}.`);
  }
  const config = Bun.TOML.parse(await file.text()) as { database?: { url?: unknown } };
  const url = config.database?.url;
  if (typeof url !== 'string' || url === '') {
    throw new Error(`No database URL: ${path} has no [database] url.`);
  }
  return url;
};
