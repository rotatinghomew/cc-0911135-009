const BOUND_KEYS = ['xmin', 'xmax', 'ymin', 'ymax', 'from', 'until'];

export { BOUND_KEYS };

export class BudgetExhaustedError extends Error {
  constructor(used, budget) {
    super(`请求预算已耗尽：已用 ${used}/${budget}`);
    this.name = 'BudgetExhaustedError';
    this.code = 'budget-exhausted';
    this.used = used;
    this.budget = budget;
    this.retryable = false;
  }
}

export class RequestAbortedError extends Error {
  constructor(message = '采集已被用户中止') {
    super(message);
    this.name = 'RequestAbortedError';
    this.code = 'aborted';
    this.retryable = false;
  }
}

export class SnapshotExpiredError extends Error {
  constructor(detail = {}) {
    super('源端拒绝旧快照（HTTP 409）');
    this.name = 'SnapshotExpiredError';
    this.code = 'snapshot-expired';
    this.detail = detail;
    this.retryable = false;
    this.fatal = true;
  }
}

export class SnapshotMismatchError extends Error {
  constructor(expected, received) {
    super(`响应快照 ${String(received)} 与请求快照 ${String(expected)} 不一致`);
    this.name = 'SnapshotMismatchError';
    this.code = 'snapshot-mismatch';
    this.expected = expected;
    this.received = received;
    this.retryable = false;
    this.fatal = true;
  }
}

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = 'protocol';
    this.retryable = false;
  }
}

export class HttpStatusError extends Error {
  constructor(status, body, path, attempts = 1) {
    super(`源端返回 HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.code = 'http';
    this.status = status;
    this.body = body;
    this.path = path;
    this.attempts = attempts;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export class TransportError extends Error {
  constructor(cause, path, attempts = 1) {
    super(`请求失败：${cause?.message || String(cause)}`);
    this.name = 'TransportError';
    this.code = 'transport';
    this.cause = cause;
    this.path = path;
    this.attempts = attempts;
    this.retryable = true;
  }
}

function requestSignal(signal, timeoutMs) {
  const parts = [];
  if (signal) parts.push(signal);
  if (timeoutMs > 0 && typeof AbortSignal.timeout === 'function') parts.push(AbortSignal.timeout(timeoutMs));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return typeof AbortSignal.any === 'function' ? AbortSignal.any(parts) : parts[0];
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeBounds(source) {
  if (!source || typeof source !== 'object') throw new ProtocolError('缺少查询边界');
  const bounds = {};
  for (const key of BOUND_KEYS) {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) throw new ProtocolError(`查询边界 ${key} 不是有限数字`);
    bounds[key] = value;
  }
  if (bounds.xmin > bounds.xmax || bounds.ymin > bounds.ymax || bounds.from > bounds.until) {
    throw new ProtocolError('查询边界下界不能大于上界');
  }
  return bounds;
}

export function validateSnapshot(body) {
  if (!body || typeof body !== 'object') throw new ProtocolError('快照响应不是 JSON 对象');
  if (typeof body.snapshot !== 'string' || body.snapshot.length === 0) {
    throw new ProtocolError('快照响应缺少 snapshot');
  }
  if (!finite(body.cap) || body.cap < 1) throw new ProtocolError('快照响应 cap 必须是正数');
  const domain = normalizeBounds(body.domain);
  if (!finite(body.minSpatial) || body.minSpatial <= 0) throw new ProtocolError('快照响应 minSpatial 必须是正数');
  if (!finite(body.minTemporal) || body.minTemporal <= 0) throw new ProtocolError('快照响应 minTemporal 必须是正数');
  return {
    snapshot: body.snapshot,
    domain,
    cap: body.cap,
    minSpatial: body.minSpatial,
    minTemporal: body.minTemporal,
  };
}

export function validateQueryResponse(body, expectedSnapshot) {
  if (!body || typeof body !== 'object') throw new ProtocolError('查询响应不是 JSON 对象');
  if (typeof body.snapshot !== 'string') throw new ProtocolError('查询响应缺少 snapshot');
  if (body.snapshot !== expectedSnapshot) throw new SnapshotMismatchError(expectedSnapshot, body.snapshot);
  if (typeof body.truncated !== 'boolean') throw new ProtocolError('查询响应缺少布尔 truncated');
  if (!Array.isArray(body.records)) throw new ProtocolError('查询响应 records 必须是数组');
  const lowerBound = body.lowerBound === undefined ? body.records.length : Number(body.lowerBound);
  if (!Number.isFinite(lowerBound)) throw new ProtocolError('查询响应 lowerBound 不是数字');
  return {
    snapshot: body.snapshot,
    records: body.records,
    truncated: body.truncated,
    lowerBound,
  };
}

/**
 * 低层 HTTP 客户端。budget 的扣减与持久化交给调用方的 beforeAttempt 回调，
 * 这样每个实际尝试（包括重试）都会在发请求前先记入预算。
 */
export class PlotClient {
  constructor(base, {
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = 10_000,
    retries = 2,
    retryDelay = 40,
    beforeAttempt = async () => {},
  } = {}) {
    if (!base) throw new Error('缺少源端地址');
    this.base = String(base).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryDelay = retryDelay;
    this.beforeAttempt = beforeAttempt;
  }

  async request(path, { method = 'GET', headers = {}, attempts = 1 } = {}) {
    if (this.signal?.aborted) throw new RequestAbortedError();
    // 先记账再发请求：预算按实际尝试次数扣，重试同样计入。
    await this.beforeAttempt({ method, path });
    let response;
    try {
      response = await this.fetchImpl(this.base + path, {
        method,
        headers,
        signal: requestSignal(this.signal, this.timeoutMs),
      });
    } catch (error) {
      if (this.signal?.aborted) throw new RequestAbortedError();
      throw new TransportError(error, path, attempts);
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (this.signal?.aborted) throw new RequestAbortedError();
      throw new TransportError(error, path, attempts);
    }
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // 非 200 响应可能不是 JSON（例如网关错误页）；保留原文用于失败原因。
        if (response.status === 200) throw new ProtocolError(`源端 ${path} 返回的响应不是 JSON`);
        body = { text: text.slice(0, 500) };
      }
    }
    return { status: response.status, body };
  }

  /** 单次请求 + 有限重试；返回 attempts 便于把真实请求次数写进证据。 */
  async #retry(path, options, run) {
    let lastError;
    let attempts = 0;
    const max = Math.max(0, this.retries) + 1;
    for (let attempt = 0; attempt < max; attempt += 1) {
      attempts += 1;
      try {
        const result = await this.request(path, { ...options, attempts });
        const value = run(result);
        if (value !== undefined) return { value, attempts };
        lastError = new HttpStatusError(result.status, result.body, path);
        if (!lastError.retryable) break;
      } catch (error) {
        if (error instanceof RequestAbortedError || error instanceof SnapshotExpiredError ||
            error instanceof SnapshotMismatchError || error instanceof ProtocolError ||
            error instanceof BudgetExhaustedError) throw error;
        if (error instanceof HttpStatusError && !error.retryable) throw error;
        lastError = error;
      }
      if (attempt + 1 < max && this.retryDelay > 0) await new Promise(resolve => setTimeout(resolve, this.retryDelay));
    }
    if (lastError instanceof HttpStatusError) throw lastError;
    throw new TransportError(lastError, path, attempts);
  }

  async snapshot() {
    const { value, attempts } = await this.#retry('/snapshot', {}, result => {
      if (result.status !== 200) {
        if (result.status === 409) throw new SnapshotExpiredError(result.body);
        return undefined;
      }
      return validateSnapshot(result.body);
    });
    return { ...value, attempts };
  }
  async query(bounds, snapshot) {
    const params = new URLSearchParams();
    for (const key of BOUND_KEYS) params.set(key, String(bounds[key]));
    const path = `/query?${params.toString()}`;
    const { value, attempts } = await this.#retry(path, { headers: { 'x-snapshot': snapshot } }, result => {
      if (result.status === 409) throw new SnapshotExpiredError(result.body);
      if (result.status !== 200) return undefined;
      return { ...validateQueryResponse(result.body, snapshot), path, bounds: normalizeBounds(bounds) };
    });
    return { ...value, attempts };
  }
}

/** 原有的一次性协议查看，保留给 probe/demo 使用。 */
export async function inspect(base) {
  const client = new PlotClient(base);
  const snapshot = await client.snapshot();
  return { snapshot, query: await client.query(snapshot.domain, snapshot.snapshot) };
}
