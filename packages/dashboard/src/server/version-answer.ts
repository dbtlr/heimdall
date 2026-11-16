import type { RunningBuild } from '../lib/update-watch.ts';

// `GET /api/version`: the build and release this server runs, which a page
// compares with its own to learn that a newer dashboard is ready. It is never
// cached, so a page always reads the server's current build.
export const versionAnswer = (running: RunningBuild): Response =>
  Response.json(running, { headers: { 'cache-control': 'no-store' } });
