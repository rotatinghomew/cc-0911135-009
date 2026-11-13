export async function inspect(base) {
  const snapshot = await (await fetch(base + '/snapshot')).json();
  const query = new URLSearchParams(snapshot.domain);
  const response = await fetch(base + '/query?' + query, { headers: { 'x-snapshot': snapshot.snapshot } });
  return { snapshot, query: await response.json() };
}
