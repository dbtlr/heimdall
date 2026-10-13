// The answer a read route gives any method but GET (and the HEAD TanStack Start
// answers from GET). Without it, TanStack Start renders the app's page with 200.
export const onlyGet = (): Response =>
  new Response('Only GET is answered here.', {
    headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
    status: 405,
  });
