// True when `moduleUrl` (a module's `import.meta.url`) lies inside an executable
// from `bun build --compile`. Bun serves a compiled binary's modules from its
// embedded file system, `/$bunfs/` on Linux and macOS and `B:/~BUN/` on Windows;
// a run from source sees the files' real paths.
export const isCompiledModule = (moduleUrl: string): boolean =>
  moduleUrl.startsWith('file:///$bunfs/') || /^file:\/\/\/[A-Za-z]:\/~BUN\//u.test(moduleUrl);

// Whether this process runs from a compiled Heimdall binary.
export const runsCompiled = (): boolean => isCompiledModule(import.meta.url);
