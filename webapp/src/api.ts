export async function api<T = any>(path: string, payload?: any): Promise<T> {
    const csrfMatch = document.cookie.match(/csrf-token=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    const res = await fetch(path, {
        method: payload ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
        },
        body: payload ? JSON.stringify(payload) : undefined,
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
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
