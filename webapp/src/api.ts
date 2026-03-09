function csrfToken(): string {
  const csrfMatch = document.cookie.match(/csrf-token=([^;]+)/);
  return csrfMatch ? csrfMatch[1] : '';
}

function normalizeOptions(payloadOrOptions?: any): {
  method: string;
  payload: any;
  headers: Record<string, string>;
} {
  if (
    payloadOrOptions
    && typeof payloadOrOptions === 'object'
    && !Array.isArray(payloadOrOptions)
    && ('method' in payloadOrOptions || 'payload' in payloadOrOptions || 'headers' in payloadOrOptions)
  ) {
    return {
      method: String(payloadOrOptions.method || (payloadOrOptions.payload !== undefined ? 'POST' : 'GET')).toUpperCase(),
      payload: payloadOrOptions.payload,
      headers: payloadOrOptions.headers || {},
    };
  }

  return {
    method: payloadOrOptions !== undefined ? 'POST' : 'GET',
    payload: payloadOrOptions,
    headers: {},
  };
}

export async function fetchWithCsrf(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-CSRF-Token', csrfToken());
  }
  return fetch(path, {
    ...init,
    method,
    headers,
  });
}

export async function api<T = any>(path: string, payloadOrOptions?: any): Promise<T> {
  const { method, payload, headers } = normalizeOptions(payloadOrOptions);
  const requestHeaders = new Headers(headers);
  if (payload !== undefined && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const res = await fetchWithCsrf(path, {
    method,
    headers: requestHeaders,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function streamNdjson<T>(
  path: string,
  payload: unknown,
  onEvent: (event: T) => void,
): Promise<void> {
  const res = await fetchWithCsrf(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(async () => ({ error: await res.text() }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Streaming response body is unavailable');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onEvent(JSON.parse(line) as T);
      newlineIndex = buffer.indexOf('\n');
    }
  }

  const rest = buffer.trim();
  if (rest) onEvent(JSON.parse(rest) as T);
}

export type ProviderMeta = {
  id: string;
  name: string;
  authType: 'oauth' | 'api-key' | 'none' | 'custom';
  source: string;
  api: string;
  hasApiKey: boolean;
  apiFormat: string;
  env: string;
  apiEnv: string;
  doc?: string;
};

export type ModelOption = {
  label: string;
  value: string;
};
