// The server Vite builds into `.output/server/` with Nitro's `standard`
// preset: a request handler with the static assets inlined. The package's
// `imports` field maps `#server-build` to it, so `heimdall-dashboard` compiles
// it in.
declare module '#server-build' {
  const server: { fetch: (request: Request) => Promise<Response> | Response };
  export default server;
}
