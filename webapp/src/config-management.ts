export type ConfigSnapshotMeta = {
  id: string;
  createdAt: string;
  size: number;
  reason: string;
};

const PREVIEW_SECRET = '********';
const SENSITIVE_KEY_RE = /(token|secret|password|api[_-]?key|verificationtoken|encryptkey)/i;

const DEFAULT_CONFIG_DRAFT = {
  agent: {
    model: '',
    codeModel: '',
    memoryWindow: 50,
    workspace: '',
    maxMemorySize: 8192,
    consolidationTimeout: 30000,
    subagentTimeout: 0,
  },
  channels: {
    telegram: { enabled: false, token: '', allowFrom: '', proxy: '' },
    cli: { enabled: true },
    dingtalk: { enabled: false, clientId: '', clientSecret: '', robotCode: '', corpId: '', allowFrom: '', keepAlive: false },
    feishu: { enabled: false, appId: '', appSecret: '', allowFrom: '', domain: 'feishu', connectionMode: 'websocket', verificationToken: '' },
  },
  providers: {},
  logLevel: 'info',
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

export function toFormConfig(config: any) {
  const source = isPlainObject(config) ? config : {};
  return {
    agent: { ...DEFAULT_CONFIG_DRAFT.agent, ...(source.agent || {}) },
    channels: {
      telegram: {
        ...DEFAULT_CONFIG_DRAFT.channels.telegram,
        ...(source.channels?.telegram || {}),
        allowFrom: Array.isArray(source.channels?.telegram?.allowFrom)
          ? source.channels.telegram.allowFrom.join(',')
          : source.channels?.telegram?.allowFrom || '',
      },
      cli: {
        ...DEFAULT_CONFIG_DRAFT.channels.cli,
        ...(source.channels?.cli || {}),
      },
      dingtalk: {
        ...DEFAULT_CONFIG_DRAFT.channels.dingtalk,
        ...(source.channels?.dingtalk || {}),
        allowFrom: Array.isArray(source.channels?.dingtalk?.allowFrom)
          ? source.channels.dingtalk.allowFrom.join(',')
          : source.channels?.dingtalk?.allowFrom || '',
      },
      feishu: {
        ...DEFAULT_CONFIG_DRAFT.channels.feishu,
        ...(source.channels?.feishu || {}),
        allowFrom: Array.isArray(source.channels?.feishu?.allowFrom)
          ? source.channels.feishu.allowFrom.join(',')
          : source.channels?.feishu?.allowFrom || '',
        domain: source.channels?.feishu?.domain || 'feishu',
        connectionMode: source.channels?.feishu?.connectionMode || 'websocket',
      },
    },
    providers: source.providers || {},
    logLevel: source.logLevel || 'info',
  };
}

export function sanitizePreviewConfig(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePreviewConfig(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const output: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key) && entry !== undefined && entry !== null && `${entry}` !== '') {
      output[key] = PREVIEW_SECRET;
      continue;
    }
    output[key] = sanitizePreviewConfig(entry);
  }
  return output;
}

export function mergeImportedConfigPreview(current: any, incoming: unknown): any {
  const currentConfig = isPlainObject(current) ? current : {};
  const body = isPlainObject(incoming) ? incoming : {};
  const payload = isPlainObject(body.config) ? body.config : body;
  const channelsRaw = isPlainObject(payload.channels) ? payload.channels : {};
  const agentRaw = isPlainObject(payload.agent) ? payload.agent : {};

  return {
    ...currentConfig,
    ...payload,
    agent: {
      ...(currentConfig.agent || {}),
      ...agentRaw,
    },
    channels: {
      ...(currentConfig.channels || {}),
      ...channelsRaw,
      telegram: {
        ...(currentConfig.channels?.telegram || {}),
        ...(isPlainObject(channelsRaw.telegram) ? channelsRaw.telegram : {}),
      },
      cli: {
        ...(currentConfig.channels?.cli || {}),
        ...(isPlainObject(channelsRaw.cli) ? channelsRaw.cli : {}),
      },
      dingtalk: {
        ...(currentConfig.channels?.dingtalk || {}),
        ...(isPlainObject(channelsRaw.dingtalk) ? channelsRaw.dingtalk : {}),
      },
      feishu: {
        ...(currentConfig.channels?.feishu || {}),
        ...(isPlainObject(channelsRaw.feishu) ? channelsRaw.feishu : {}),
      },
    },
    providers: payload.providers !== undefined ? payload.providers : currentConfig.providers,
  };
}

export function collectChangedPaths(currentValue: any, nextValue: any, basePath = ''): string[] {
  if (currentValue === nextValue) return [];

  if (Array.isArray(currentValue) || Array.isArray(nextValue)) {
    return JSON.stringify(currentValue) === JSON.stringify(nextValue)
      ? []
      : [basePath || '(root)'];
  }

  const currentIsObject = isPlainObject(currentValue);
  const nextIsObject = isPlainObject(nextValue);
  if (!currentIsObject || !nextIsObject) {
    return [basePath || '(root)'];
  }

  const keys = new Set([...Object.keys(currentValue), ...Object.keys(nextValue)]);
  const result: string[] = [];
  for (const key of keys) {
    const path = basePath ? `${basePath}.${key}` : key;
    result.push(...collectChangedPaths(currentValue[key], nextValue[key], path));
  }
  return result;
}

export function summarizeChangedPaths(paths: string[]) {
  const unique = Array.from(new Set(paths));
  const topSections = Array.from(
    new Set(
      unique
        .filter((item) => item && item !== '(root)')
        .map((item) => item.split('.')[0]),
    ),
  );
  return {
    paths: unique,
    topSections,
    total: unique.length,
  };
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatTimestamp(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatSnapshotReason(reason: string, locale: string): string {
  const normalized = reason.trim().toLowerCase();
  if (normalized === 'before-import') {
    return locale === 'zh' ? '导入前快照' : 'Before import';
  }
  if (normalized === 'before-rollback') {
    return locale === 'zh' ? '回滚前备份' : 'Before rollback';
  }
  return reason || (locale === 'zh' ? '手动快照' : 'Manual');
}

export function buildExportFilename(now = new Date()): string {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `neoclaw-config-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
}

export function downloadJsonFile(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function readJsonFile(file: File): Promise<any> {
  const text = await file.text();
  return JSON.parse(text);
}
