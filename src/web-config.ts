import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

export type ProviderType = 'claude' | 'openai-compatible';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface WebUiConfig {
  assistantName?: string;
  defaultProviderId?: string;
  providers: ProviderConfig[];
  updatedAt?: string;
}

const WEB_CONFIG_FILE = path.join(DATA_DIR, 'webui-config.json');

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_KIMI_BASE = 'https://api.moonshot.cn';
const DEFAULT_GLM_BASE = 'https://open.bigmodel.cn';

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toProviderConfig(input: Partial<ProviderConfig>): ProviderConfig | null {
  const id = typeof input.id === 'string' ? input.id : randomId('provider');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const type = input.type === 'openai-compatible' ? 'openai-compatible' : 'claude';
  const baseUrl =
    typeof input.baseUrl === 'string' && input.baseUrl.trim().length > 0
      ? input.baseUrl.trim().replace(/\/$/, '')
      : type === 'claude'
        ? DEFAULT_ANTHROPIC_BASE
        : '';
  const apiKey =
    typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const models = Array.isArray(input.models)
    ? input.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : [];
  const defaultModel =
    typeof input.defaultModel === 'string' && input.defaultModel.trim().length > 0
      ? input.defaultModel.trim()
      : models[0];

  if (!name || !baseUrl || !apiKey) return null;

  const stamp = nowIso();
  return {
    id,
    name,
    type,
    baseUrl,
    apiKey,
    enabled: input.enabled !== false,
    models,
    defaultModel,
    headers:
      input.headers && typeof input.headers === 'object' ? input.headers : undefined,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : stamp,
    updatedAt: stamp,
  };
}

function normalize(config: Partial<WebUiConfig>): WebUiConfig {
  const assistantName =
    typeof config.assistantName === 'string' && config.assistantName.trim().length > 0
      ? config.assistantName.trim()
      : undefined;

  const providersInput = Array.isArray(config.providers) ? config.providers : [];
  const providers = providersInput
    .map((p) => toProviderConfig(p))
    .filter((p): p is ProviderConfig => p !== null);

  let defaultProviderId =
    typeof config.defaultProviderId === 'string' ? config.defaultProviderId : undefined;
  if (!defaultProviderId || !providers.some((p) => p.id === defaultProviderId)) {
    defaultProviderId = providers[0]?.id;
  }

  return {
    assistantName,
    defaultProviderId,
    providers,
    updatedAt: nowIso(),
  };
}

export function readWebUiConfig(): WebUiConfig {
  ensureDataDir();
  if (!fs.existsSync(WEB_CONFIG_FILE)) {
    return {
      providers: [],
      updatedAt: nowIso(),
    };
  }

  try {
    const content = fs.readFileSync(WEB_CONFIG_FILE, 'utf-8');
    const raw = JSON.parse(content) as Partial<WebUiConfig>;
    return normalize(raw);
  } catch {
    return {
      providers: [],
      updatedAt: nowIso(),
    };
  }
}

export function writeWebUiConfig(config: Partial<WebUiConfig>): WebUiConfig {
  ensureDataDir();
  const sanitized = normalize(config);
  fs.writeFileSync(WEB_CONFIG_FILE, JSON.stringify(sanitized, null, 2) + '\n', {
    mode: 0o600,
  });
  return sanitized;
}

export function updateWebUiConfig(
  mutator: (current: WebUiConfig) => WebUiConfig,
): WebUiConfig {
  const current = readWebUiConfig();
  const next = normalize(mutator(current));
  fs.writeFileSync(WEB_CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', {
    mode: 0o600,
  });
  return next;
}

export function getProviderById(
  config: WebUiConfig,
  providerId?: string,
): ProviderConfig | undefined {
  const id = providerId || config.defaultProviderId;
  if (!id) return undefined;
  return config.providers.find((p) => p.id === id);
}

export function createPresetProviders(): Array<Partial<ProviderConfig>> {
  const t = nowIso();
  return [
    {
      id: 'anthropic-default',
      name: 'Anthropic Claude',
      type: 'claude',
      baseUrl: DEFAULT_ANTHROPIC_BASE,
      apiKey: '',
      enabled: true,
      models: [],
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'deepseek-default',
      name: 'DeepSeek',
      type: 'openai-compatible',
      baseUrl: DEFAULT_DEEPSEEK_BASE,
      apiKey: '',
      enabled: false,
      models: [],
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'kimi-default',
      name: 'Kimi (Moonshot)',
      type: 'openai-compatible',
      baseUrl: DEFAULT_KIMI_BASE,
      apiKey: '',
      enabled: false,
      models: [],
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'glm-default',
      name: 'GLM',
      type: 'openai-compatible',
      baseUrl: DEFAULT_GLM_BASE,
      apiKey: '',
      enabled: false,
      models: [],
      createdAt: t,
      updatedAt: t,
    },
  ];
}
