import { readFile } from 'node:fs/promises';
import { serve, json } from '../lib/http.mjs';
const records = JSON.parse(await readFile(new URL('../data/observations.json', import.meta.url)));
export async function createSite(port = 0) {
  return serve(({ request, response, url, state }) => {
    if (url.pathname === '/snapshot') {
      json(response, 200, { snapshot: `plot-${state.generation}`, domain: { xmin: 0, xmax: 4, ymin: 0, ymax: 4, from: 0, until: 4 },
        cap: state.cap, minSpatial: 0.25, minTemporal: 1 }); return true;
    }
    if (url.pathname !== '/query') return false;
    if (request.headers['x-snapshot'] !== `plot-${state.generation}`) {
      json(response, 409, { error: 'snapshot-expired', generation: state.generation }); return true;
    }
    const box = Object.fromEntries(['xmin', 'xmax', 'ymin', 'ymax', 'from', 'until'].map(key => [key, Number(url.searchParams.get(key))]));
    if (['xmin', 'xmax', 'ymin', 'ymax', 'from', 'until'].some(key => !url.searchParams.has(key) || !Number.isFinite(box[key])) ||
        box.xmin > box.xmax || box.ymin > box.ymax || box.from > box.until) throw new Error('查询边界无效');
    const selected = records.filter(record => record.x >= box.xmin && record.x <= box.xmax && record.y >= box.ymin && record.y <= box.ymax && record.time >= box.from && record.time <= box.until);
    json(response, 200, { snapshot: `plot-${state.generation}`, bounds: box, records: selected.slice(0, state.cap),
      truncated: selected.length > state.cap, lowerBound: Math.min(selected.length, state.cap + 1) });
    return true;
  }, { generation: 1, cap: 3 }, port);
}
