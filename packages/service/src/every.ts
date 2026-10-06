// Runs `task` now and again `intervalMs` after each run finishes, so runs never
// overlap. A failing run goes to `onError` and the timer carries on. The
// returned function stops the timer and waits for a run still in flight, so the
// caller can close what the task uses. With `runNow: false`, the first run
// waits one interval.
export const every = ({
  intervalMs,
  onError,
  runNow = true,
  task,
}: {
  intervalMs: number;
  onError: (error: unknown) => void;
  runNow?: boolean;
  task: () => unknown;
}): (() => Promise<void>) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const run = async () => {
    try {
      await task();
    } catch (error) {
      onError(error);
    }
    schedule();
  };
  const schedule = () => {
    if (!stopped) {
      timer = setTimeout(() => {
        running = run();
      }, intervalMs);
    }
  };
  if (runNow) {
    running = run();
  } else {
    schedule();
  }
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
};
