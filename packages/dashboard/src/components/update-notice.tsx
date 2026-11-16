import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { reloadsForMissingChunk, watchForUpdates } from '../lib/update-watch.ts';
import type { RunningBuild, UpdateHost, UpdateState } from '../lib/update-watch.ts';
import { DASHBOARD_BUILD, DASHBOARD_VERSION } from '../version.ts';

const RUNNING: RunningBuild = { build: DASHBOARD_BUILD, version: DASHBOARD_VERSION };

// Where the page notes when it last reloaded for a missing chunk.
const CHUNK_RELOAD_KEY = 'heimdall:chunk-reload-at';

const reloadPage = () => {
  globalThis.location.reload();
};

const isRunningBuild = (value: unknown): value is RunningBuild =>
  typeof value === 'object' &&
  value !== null &&
  'build' in value &&
  typeof value.build === 'string' &&
  'version' in value &&
  typeof value.version === 'string';

// The server's build, or undefined when it did not answer with one.
const readServerBuild = async (): Promise<RunningBuild | undefined> => {
  const response = await fetch('/api/version', { cache: 'no-store' });
  if (!response.ok) {
    return undefined;
  }
  const answer: unknown = await response.json();
  return isRunningBuild(answer) ? { build: answer.build, version: answer.version } : undefined;
};

const browser: UpdateHost = {
  isHidden: () => document.hidden,
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => {
      document.removeEventListener('visibilitychange', listener);
    };
  },
  readBuild: readServerBuild,
  reload: reloadPage,
  repeat: (tick, everyMs) => {
    const timer = setInterval(tick, everyMs);
    return () => {
      clearInterval(timer);
    };
  },
};

// Session storage can be missing or refuse a write, as in a private window.
// Without it, only the server's answer keeps a missing chunk from reloading again.
const lastChunkReload = (): number | undefined => {
  try {
    const at = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY));
    return at > 0 ? at : undefined;
  } catch {
    return undefined;
  }
};

const noteChunkReload = (at: number) => {
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(at));
  } catch {
    // Nothing to keep it in; the next missing chunk reloads again.
  }
};

const UpdateContext = createContext<UpdateState>({ kind: 'unknown' });

// The pill that offers a newer build while the page is in use: above the
// phone's tab bar, and at the bottom of a wider window. It has no close
// button, because coming back to the page after leaving it reloads anyway.
export function UpdatePill({ onReload, state }: { onReload: () => void; state: UpdateState }) {
  if (state.kind !== 'ready') {
    return null;
  }
  return (
    <div
      className="fixed inset-x-0 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 sm:bottom-6"
      role="status"
    >
      <div className="flex items-center gap-3 rounded-full border bg-popover py-1.5 pr-1.5 pl-4 text-sm shadow-[0_10px_30px_rgb(0_0_0/0.6)]">
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-primary shadow-[0_0_0_4px_rgb(127_176_255/0.18)]"
        />
        New version ready
        <button
          className="rounded-full bg-primary px-3 py-1 font-semibold text-primary-foreground"
          onClick={onReload}
          type="button"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

const versionWords = (running: RunningBuild, state: UpdateState): string => {
  if (state.kind === 'ready') {
    const ready = state.version === running.version ? 'a newer build' : `v${state.version}`;
    return `Running v${running.version} · ${ready} is ready`;
  }
  return state.kind === 'current' ? `v${running.version} · up to date` : `v${running.version}`;
};

// The More page's row for the dashboard's own version: whether a newer one is
// ready, and a button to load it. A home-screen app has no reload of its own,
// so the button stays, as Reload, when the page is up to date.
export function DashboardVersionRow({
  onReload,
  running,
  state,
}: {
  onReload: () => void;
  running: RunningBuild;
  state: UpdateState;
}) {
  const ready = state.kind === 'ready';
  return (
    <div className="flex min-h-13 items-center justify-between gap-3 px-4 py-2">
      <span className="flex flex-col">
        <span className="font-semibold">Dashboard version</span>
        <span className="text-sm text-muted-foreground">{versionWords(running, state)}</span>
      </span>
      <button
        className={
          ready
            ? 'rounded-full bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground'
            : 'rounded-full border px-3 py-1 text-sm font-semibold text-muted-foreground hover:text-foreground'
        }
        onClick={onReload}
        type="button"
      >
        {ready ? 'Update' : 'Reload'}
      </button>
    </div>
  );
}

// The More page's version row, fed by the watcher around the page.
export function DashboardVersion() {
  return (
    <DashboardVersionRow
      onReload={reloadPage}
      running={RUNNING}
      state={useContext(UpdateContext)}
    />
  );
}

// Watches for the server serving a newer dashboard build than this page runs,
// gives what it learns to the page below, and shows the pill when one is
// ready. A script chunk that fails to load, as a page on an older build finds
// once the new build renamed its files, reloads the page when the server
// confirms it runs another build.
export function UpdateWatcher({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState>({ kind: 'unknown' });
  useEffect(() => watchForUpdates(RUNNING, browser, setState), []);
  useEffect(() => {
    // The error still reaches the router, which shows it; the reload, when
    // the server confirms a newer build, replaces it.
    const onPreloadError = () => {
      void (async () => {
        const server = await readServerBuild().catch(() => undefined);
        const now = Date.now();
        if (
          reloadsForMissingChunk({ lastReloadAt: lastChunkReload(), now, running: RUNNING, server })
        ) {
          noteChunkReload(now);
          reloadPage();
        }
      })();
    };
    globalThis.addEventListener('vite:preloadError', onPreloadError);
    return () => {
      globalThis.removeEventListener('vite:preloadError', onPreloadError);
    };
  }, []);
  return (
    <UpdateContext value={state}>
      {children}
      <UpdatePill onReload={reloadPage} state={state} />
    </UpdateContext>
  );
}
