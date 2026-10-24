// What the dashboard's read routes share: their plain-text answers and the
// `unpaired` parameter.

export const UNAVAILABLE = 'The dashboard cannot answer right now; try again later.';

export const plain = (status: number, body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' }, status });

// Whether `?unpaired=include`, given any number of times, adds the Systems that
// were unpaired; a 400 for any other value.
export const unpairedParam = (url: URL): boolean | Response => {
  const unpaired = url.searchParams.getAll('unpaired');
  if (unpaired.some((value) => value !== 'include')) {
    return plain(400, 'The only value for unpaired is include: ?unpaired=include.');
  }
  return unpaired.length > 0;
};
