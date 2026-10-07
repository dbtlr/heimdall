// An HTTP server on a free loopback port that answers every request with
// `answer` and records each one's path and body, standing in for the Hub.
export const fakeHub = (answer: () => Response) => {
  const requests: { body: string; method: string; path: string }[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      requests.push({
        body: await request.text(),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return answer();
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return {
    requests,
    url: `http://127.0.0.1:${String(server.port)}`,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
};

// A loopback URL nothing listens on, for a Hub that cannot be reached.
export const unreachableHub = () => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const { port } = probe;
  probe.stop(true);
  return `http://127.0.0.1:${String(port)}/`;
};

// A Hub that answers every request with the raw HTTP bytes `answer` gives and
// then closes the connection, for answers no well-behaved server sends, such
// as a body cut off before its Content-Length.
export const rawHub = (answer: string) => {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket) => {
        socket.write(answer);
        socket.end();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    [Symbol.asyncDispose]: async () => server.stop(true),
  };
};

// A body that sends `head` and then never finishes.
export const stalledBody = (head: string) =>
  new ReadableStream({
    // oxlint-disable-next-line promise/avoid-new -- a pull that never settles stalls the body.
    pull: () => new Promise(() => {}),
    start: (controller) => controller.enqueue(new TextEncoder().encode(head)),
  });
