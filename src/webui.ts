import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  getChatMessages,
  getSession,
  initDatabase,
  setSession,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  installSkillFromGit,
  installSkillFromLocalPath,
  listInstalledSkills,
  searchSkillCatalog,
} from './skills-market.js';
import { RegisteredGroup } from './types.js';
import {
  ProviderConfig,
  createPresetProviders,
  getProviderById,
  readWebUiConfig,
  updateWebUiConfig,
  writeWebUiConfig,
} from './web-config.js';

const WEBUI_PORT = parseInt(process.env.WEBUI_PORT || '3000', 10);
const WEB_GROUP_FOLDER = 'web';
const WEB_CHAT_JID = 'web:local';

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function stripInternal(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function textResponse(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = 'text/html; charset=utf-8',
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeProvider(input: Partial<ProviderConfig>): ProviderConfig {
  const stamp = nowIso();
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomId('provider'),
    name: typeof input.name === 'string' ? input.name.trim() : 'Provider',
    type: input.type === 'openai-compatible' ? 'openai-compatible' : 'claude',
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/$/, '') : '',
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    enabled: input.enabled !== false,
    models: Array.isArray(input.models)
      ? input.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : [],
    defaultModel:
      typeof input.defaultModel === 'string' && input.defaultModel.trim().length > 0
        ? input.defaultModel.trim()
        : undefined,
    headers:
      input.headers && typeof input.headers === 'object' ? input.headers : undefined,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : stamp,
    updatedAt: stamp,
  };
}

async function fetchModels(provider: ProviderConfig): Promise<string[]> {
  const base = provider.baseUrl.replace(/\/$/, '');
  const url = `${base}/v1/models`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(provider.type === 'claude'
      ? {
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : {
          Authorization: `Bearer ${provider.apiKey}`,
        }),
    ...(provider.headers || {}),
  };

  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`model_fetch_failed:${resp.status}:${t.slice(0, 180)}`);
  }

  const data = (await resp.json()) as {
    data?: Array<{ id?: string; name?: string }>;
    models?: Array<{ id?: string; name?: string }>;
  };

  const list = (Array.isArray(data.data) ? data.data : data.models || [])
    .map((m) => m.id || m.name || '')
    .filter((m) => m.length > 0);

  return Array.from(new Set(list)).sort();
}

async function runClaudeContainer(message: string, provider: ProviderConfig): Promise<string> {
  const cfg = readWebUiConfig();

  const group: RegisteredGroup = {
    name: 'WebUI',
    folder: WEB_GROUP_FOLDER,
    trigger: '@Web',
    added_at: nowIso(),
    requiresTrigger: false,
  };

  writeTasksSnapshot(WEB_GROUP_FOLDER, true, []);
  writeGroupsSnapshot(WEB_GROUP_FOLDER, true, [], new Set());

  const sessionId = getSession(WEB_GROUP_FOLDER);
  const chunks: string[] = [];

  const result = await runContainerAgent(
    group,
    {
      prompt: message,
      sessionId,
      groupFolder: WEB_GROUP_FOLDER,
      chatJid: WEB_CHAT_JID,
      isMain: true,
      assistantName: cfg.assistantName || 'Assistant',
      secrets: {
        ANTHROPIC_API_KEY: provider.apiKey,
      },
      ...(provider.defaultModel ? { model: provider.defaultModel } : {}),
    },
    () => {
      // no-op for web mode
    },
    async (output: ContainerOutput) => {
      if (output.newSessionId) {
        setSession(WEB_GROUP_FOLDER, output.newSessionId);
      }
      if (!output.result) return;
      const raw =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result);
      const cleaned = stripInternal(raw);
      if (cleaned) chunks.push(cleaned);
    },
  );

  if (result.status === 'error') {
    throw new Error(result.error || 'container_error');
  }

  return chunks.join('\n\n').trim() || '(No user-visible output)';
}

async function runOpenAiCompatible(
  message: string,
  provider: ProviderConfig,
  model?: string,
): Promise<string> {
  const selected = model || provider.defaultModel || provider.models[0];
  if (!selected) {
    throw new Error('model_required_for_provider');
  }

  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
    ...(provider.headers || {}),
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: selected,
      messages: [{ role: 'user', content: message }],
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`chat_failed:${resp.status}:${t.slice(0, 180)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('empty_response');
  return text;
}

async function runChat(
  message: string,
  provider: ProviderConfig,
  model?: string,
): Promise<string> {
  if (provider.type === 'claude') {
    if (model) {
      provider.defaultModel = model;
    }
    return runClaudeContainer(message, provider);
  }
  return runOpenAiCompatible(message, provider, model);
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NanoClaw Config Center</title>
  <style>
    :root {
      --bg: #f2f5f8;
      --panel: #fff;
      --ink: #1a2330;
      --muted: #5d6b79;
      --line: #d8e0e8;
      --accent: #0a7a67;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"IBM Plex Sans","Segoe UI",sans-serif; background: linear-gradient(120deg,#edf8f4,#f5f7fb); color:var(--ink); }
    .page { max-width: 1100px; margin: 0 auto; padding: 16px; display:grid; gap:12px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px; }
    h1,h2 { margin:0 0 10px; }
    .muted{ color:var(--muted); font-size:12px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    input, select, textarea, button { font: inherit; border:1px solid var(--line); border-radius:10px; padding:8px 10px; }
    input, select, textarea { background:#fff; color:var(--ink); }
    button { background:var(--accent); color:#fff; border:none; cursor:pointer; }
    button.secondary { background:#334155; }
    button.danger { background:var(--danger); }
    table { width:100%; border-collapse: collapse; font-size:13px; }
    th,td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align: top; }
    #messages { max-height:320px; overflow:auto; border:1px solid var(--line); border-radius:10px; padding:8px; display:grid; gap:8px; background:#f9fbfd; }
    .msg { border:1px solid var(--line); background:#fff; border-radius:8px; padding:8px; white-space:pre-wrap; }
    .msg.user { background:#e8f7f3; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    @media (max-width: 900px) { .grid2 { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main class="page">
    <section class="card">
      <h1>NanoClaw Configuration Center</h1>
      <div id="runtime" class="muted">Loading...</div>
    </section>

    <section class="card">
      <h2>Providers</h2>
      <div class="muted">Support: Anthropic Claude, DeepSeek, Kimi, GLM, and custom OpenAI-compatible APIs.</div>
      <div style="height:8px"></div>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Base URL</th><th>Models</th><th>Default</th><th>Actions</th></tr></thead>
        <tbody id="providersTable"></tbody>
      </table>
      <div style="height:10px"></div>
      <div class="row">
        <button id="bootstrapProviders" class="secondary">Add Presets</button>
      </div>
      <hr style="border:none;border-top:1px solid var(--line);margin:12px 0;"/>
      <h3 style="margin:0 0 8px">Add / Update Provider</h3>
      <div class="grid2">
        <input id="providerId" placeholder="Provider ID (leave blank to create)" />
        <input id="providerName" placeholder="Name" />
      </div>
      <div class="grid2" style="margin-top:8px">
        <select id="providerType">
          <option value="claude">Claude (Agent SDK)</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
        <input id="providerBaseUrl" placeholder="Base URL (e.g. https://api.deepseek.com)" />
      </div>
      <div class="grid2" style="margin-top:8px">
        <input id="providerApiKey" type="password" placeholder="API Key" />
        <input id="providerModel" placeholder="Default model (optional)" />
      </div>
      <div class="row" style="margin-top:8px">
        <button id="saveProvider">Save Provider</button>
      </div>
      <div id="providerResult" class="muted" style="margin-top:6px"></div>
    </section>

    <section class="card grid2">
      <div>
        <h2>Chat</h2>
        <div id="messages"></div>
        <div style="height:8px"></div>
        <textarea id="prompt" placeholder="Type message..."></textarea>
        <div class="row" style="margin-top:8px">
          <select id="chatProvider"></select>
          <select id="chatModel"></select>
          <button id="send">Send</button>
          <button id="reloadHistory" class="secondary">Reload</button>
        </div>
        <div id="chatStatus" class="muted" style="margin-top:6px"></div>
      </div>
      <div>
        <h2>Skill Market</h2>
        <div class="row">
          <input id="skillQuery" placeholder="Search skills" />
          <button id="searchSkills" class="secondary">Search</button>
        </div>
        <div id="skillCatalog" class="muted" style="margin-top:8px"></div>
        <hr style="border:none;border-top:1px solid var(--line);margin:12px 0;"/>
        <div class="muted">Install from local folder containing skill directories:</div>
        <div class="row" style="margin-top:6px">
          <input id="skillLocalPath" placeholder="./some-repo/.claude/skills" />
          <button id="installLocal">Install Local</button>
        </div>
        <div class="muted" style="margin-top:10px">Install from git repo (auto reads .claude/skills):</div>
        <div class="row" style="margin-top:6px">
          <input id="skillGitUrl" placeholder="https://github.com/org/repo.git" />
          <button id="installGit">Install Git</button>
        </div>
        <div id="skillResult" class="muted" style="margin-top:8px"></div>
        <div id="installedSkills" class="muted" style="margin-top:8px"></div>
      </div>
    </section>
  </main>

  <script>
    const runtimeEl = document.getElementById('runtime');
    const providersTableEl = document.getElementById('providersTable');
    const providerResultEl = document.getElementById('providerResult');
    const chatProviderEl = document.getElementById('chatProvider');
    const chatModelEl = document.getElementById('chatModel');
    const messagesEl = document.getElementById('messages');
    const chatStatusEl = document.getElementById('chatStatus');
    const skillCatalogEl = document.getElementById('skillCatalog');
    const skillResultEl = document.getElementById('skillResult');
    const installedSkillsEl = document.getElementById('installedSkills');

    let providers = [];

    function esc(text) {
      return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderProviderOptions() {
      chatProviderEl.innerHTML = providers.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.type)})</option>`).join('');
      renderModelOptions();
    }

    function renderModelOptions() {
      const selected = providers.find(p => p.id === chatProviderEl.value) || providers[0];
      const models = selected ? selected.models || [] : [];
      chatModelEl.innerHTML = models.length
        ? models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
        : '<option value="">(Use provider default)</option>';
      if (selected && selected.defaultModel) {
        chatModelEl.value = selected.defaultModel;
      }
    }

    function addMessage(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
      div.innerHTML = '<strong>' + (role === 'user' ? 'You' : 'Assistant') + ':</strong>\\n' + esc(text);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      runtimeEl.textContent = `Runtime: ${data.runtimeReady ? 'ready' : 'not ready'} | Providers: ${data.providerCount}` + (data.runtimeError ? ` | Error: ${data.runtimeError}` : '');
    }

    async function loadProviders() {
      const res = await fetch('/api/providers');
      const data = await res.json();
      providers = data.providers || [];
      providersTableEl.innerHTML = providers.map(p => `
        <tr>
          <td>${esc(p.name)}</td>
          <td>${esc(p.type)}</td>
          <td><code>${esc(p.baseUrl)}</code></td>
          <td>${(p.models || []).map(esc).join('<br/>') || '(none)'}</td>
          <td>${esc(p.defaultModel || '')}</td>
          <td>
            <div class="row">
              <button data-act="refresh" data-id="${esc(p.id)}" class="secondary">Refresh Models</button>
              <button data-act="default" data-id="${esc(p.id)}" class="secondary">Set Default</button>
              <button data-act="delete" data-id="${esc(p.id)}" class="danger">Delete</button>
            </div>
          </td>
        </tr>
      `).join('');
      renderProviderOptions();
    }

    async function loadHistory() {
      const res = await fetch('/api/history');
      const data = await res.json();
      messagesEl.innerHTML = '';
      (data.messages || []).forEach(m => addMessage(m.role, m.content));
    }

    async function searchSkills() {
      const q = document.getElementById('skillQuery').value || '';
      const res = await fetch('/api/skills/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      skillCatalogEl.innerHTML = (data.skills || []).map(s => `• <strong>${esc(s.name)}</strong> — ${esc(s.summary)}`).join('<br/>') || 'No skills';
    }

    async function loadInstalledSkills() {
      const res = await fetch('/api/skills/installed');
      const data = await res.json();
      installedSkillsEl.innerHTML = 'Installed: ' + ((data.skills || []).map(esc).join(', ') || '(none)');
    }

    document.getElementById('bootstrapProviders').addEventListener('click', async () => {
      const res = await fetch('/api/providers/bootstrap', { method: 'POST' });
      const data = await res.json();
      providerResultEl.textContent = data.ok ? 'Preset providers added.' : ('Failed: ' + (data.error || 'unknown'));
      await loadProviders();
      await loadStatus();
    });

    document.getElementById('saveProvider').addEventListener('click', async () => {
      const payload = {
        id: document.getElementById('providerId').value || undefined,
        name: document.getElementById('providerName').value,
        type: document.getElementById('providerType').value,
        baseUrl: document.getElementById('providerBaseUrl').value,
        apiKey: document.getElementById('providerApiKey').value,
        defaultModel: document.getElementById('providerModel').value || undefined,
      };
      const res = await fetch('/api/providers/upsert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      providerResultEl.textContent = data.ok ? 'Provider saved.' : ('Save failed: ' + (data.error || 'unknown'));
      await loadProviders();
      await loadStatus();
    });

    providersTableEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-id]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      if (!id || !act) return;

      if (act === 'delete') {
        const res = await fetch('/api/providers/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
        });
        const data = await res.json();
        providerResultEl.textContent = data.ok ? 'Provider deleted.' : ('Delete failed: ' + (data.error || 'unknown'));
      } else if (act === 'default') {
        const res = await fetch('/api/providers/set-default', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
        });
        const data = await res.json();
        providerResultEl.textContent = data.ok ? 'Default provider updated.' : ('Update failed: ' + (data.error || 'unknown'));
      } else if (act === 'refresh') {
        providerResultEl.textContent = 'Refreshing models...';
        const res = await fetch('/api/providers/models/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
        });
        const data = await res.json();
        providerResultEl.textContent = data.ok
          ? `Models refreshed (${(data.models || []).length}).`
          : ('Refresh failed: ' + (data.error || 'unknown'));
      }

      await loadProviders();
      await loadStatus();
    });

    chatProviderEl.addEventListener('change', renderModelOptions);

    document.getElementById('send').addEventListener('click', async () => {
      const message = document.getElementById('prompt').value.trim();
      if (!message) return;
      document.getElementById('prompt').value = '';
      addMessage('user', message);
      chatStatusEl.textContent = 'Running...';
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, providerId: chatProviderEl.value, model: chatModelEl.value || undefined }),
      });
      const data = await res.json();
      if (!res.ok) addMessage('assistant', 'Error: ' + (data.error || 'unknown'));
      else addMessage('assistant', data.reply || '(empty)');
      chatStatusEl.textContent = '';
    });

    document.getElementById('reloadHistory').addEventListener('click', loadHistory);

    document.getElementById('searchSkills').addEventListener('click', searchSkills);

    document.getElementById('installLocal').addEventListener('click', async () => {
      const sourcePath = document.getElementById('skillLocalPath').value.trim();
      const res = await fetch('/api/skills/install-local', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourcePath }),
      });
      const data = await res.json();
      skillResultEl.textContent = data.ok
        ? `Installed: ${(data.installed || []).join(', ') || '(none)'}; skipped: ${(data.skipped || []).join(', ') || '(none)'}`
        : ('Install failed: ' + (data.error || 'unknown'));
      await loadInstalledSkills();
    });

    document.getElementById('installGit').addEventListener('click', async () => {
      const repoUrl = document.getElementById('skillGitUrl').value.trim();
      const res = await fetch('/api/skills/install-git', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl }),
      });
      const data = await res.json();
      skillResultEl.textContent = data.ok
        ? `Installed: ${(data.installed || []).join(', ') || '(none)'}; skipped: ${(data.skipped || []).join(', ') || '(none)'}`
        : ('Install failed: ' + (data.error || 'unknown'));
      await loadInstalledSkills();
    });

    Promise.resolve()
      .then(loadStatus)
      .then(loadProviders)
      .then(loadHistory)
      .then(searchSkills)
      .then(loadInstalledSkills)
      .catch((err) => {
        runtimeEl.textContent = 'Init failed: ' + String(err);
      });
  </script>
</body>
</html>`;

function ensurePresetProviders(): void {
  const cfg = readWebUiConfig();
  if (cfg.providers.length > 0) return;
  writeWebUiConfig({
    ...cfg,
    providers: createPresetProviders().map((p) => sanitizeProvider(p)),
    defaultProviderId: 'anthropic-default',
  });
}

async function handleChat(body: unknown, res: http.ServerResponse): Promise<void> {
  const payload = body as { message?: unknown; providerId?: unknown; model?: unknown };
  if (typeof payload.message !== 'string' || !payload.message.trim()) {
    jsonResponse(res, 400, { error: 'message_required' });
    return;
  }

  const config = readWebUiConfig();
  const provider =
    getProviderById(
      config,
      typeof payload.providerId === 'string' ? payload.providerId : undefined,
    ) || config.providers[0];

  if (!provider) {
    jsonResponse(res, 400, { error: 'no_provider_configured' });
    return;
  }

  if (!provider.apiKey || !provider.baseUrl) {
    jsonResponse(res, 400, { error: 'provider_not_ready' });
    return;
  }

  const model = typeof payload.model === 'string' ? payload.model : undefined;
  const message = payload.message.trim();
  const timestamp = nowIso();

  storeChatMetadata(WEB_CHAT_JID, timestamp, 'Local Web Chat', 'web', false);
  storeMessageDirect({
    id: randomId('web-user'),
    chat_jid: WEB_CHAT_JID,
    sender: 'web-user',
    sender_name: 'You',
    content: `[${provider.name}] ${message}`,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });

  try {
    const reply = await runChat(message, provider, model);

    const replyTs = nowIso();
    storeChatMetadata(WEB_CHAT_JID, replyTs, 'Local Web Chat', 'web', false);
    storeMessageDirect({
      id: randomId('web-bot'),
      chat_jid: WEB_CHAT_JID,
      sender: 'web-assistant',
      sender_name: 'Assistant',
      content: `[${provider.name}] ${reply}`,
      timestamp: replyTs,
      is_from_me: true,
      is_bot_message: true,
    });

    jsonResponse(res, 200, { reply, provider: provider.name });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Web chat request failed');
    jsonResponse(res, 500, { error });
  }
}

function createServer(runtimeState: { ready: boolean; error?: string }): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        jsonResponse(res, 400, { error: 'bad_request' });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/') {
        textResponse(res, 200, INDEX_HTML);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        const cfg = readWebUiConfig();
        jsonResponse(res, 200, {
          runtimeReady: runtimeState.ready,
          runtimeError: runtimeState.error || null,
          providerCount: cfg.providers.length,
          defaultProviderId: cfg.defaultProviderId || null,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const cfg = readWebUiConfig();
        jsonResponse(res, 200, {
          assistantName: cfg.assistantName || null,
          defaultProviderId: cfg.defaultProviderId || null,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/providers') {
        const cfg = readWebUiConfig();
        jsonResponse(res, 200, {
          defaultProviderId: cfg.defaultProviderId || null,
          providers: cfg.providers.map((p) => ({
            ...p,
            apiKey: p.apiKey ? '***' : '',
          })),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/providers/bootstrap') {
        const cfg = readWebUiConfig();
        const presets = createPresetProviders().map((p) => sanitizeProvider(p));
        const existingIds = new Set(cfg.providers.map((p) => p.id));
        const merged = [...cfg.providers];
        for (const preset of presets) {
          if (!existingIds.has(preset.id)) merged.push(preset);
        }
        const next = writeWebUiConfig({
          ...cfg,
          providers: merged,
          defaultProviderId: cfg.defaultProviderId || 'anthropic-default',
        });
        jsonResponse(res, 200, { ok: true, count: next.providers.length });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/providers/upsert') {
        const payload = (await readJsonBody(req)) as Partial<ProviderConfig>;
        const provider = sanitizeProvider(payload);
        const cfg = readWebUiConfig();
        const existing = cfg.providers.find((p) => p.id === provider.id);
        if (
          !provider.name ||
          !provider.baseUrl ||
          (!provider.apiKey && !existing?.apiKey)
        ) {
          jsonResponse(res, 400, { ok: false, error: 'name_baseurl_apikey_required' });
          return;
        }
        const next = updateWebUiConfig((current) => {
          const idx = current.providers.findIndex((p) => p.id === provider.id);
          if (idx >= 0) {
            const prev = current.providers[idx];
            current.providers[idx] = {
              ...prev,
              ...provider,
              apiKey:
                typeof payload.apiKey === 'string' && payload.apiKey.trim().length > 0
                  ? provider.apiKey
                  : prev.apiKey,
            };
          } else {
            current.providers.push(provider);
          }
          if (!current.defaultProviderId) current.defaultProviderId = provider.id;
          return current;
        });
        jsonResponse(res, 200, { ok: true, defaultProviderId: next.defaultProviderId });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/providers/delete') {
        const payload = (await readJsonBody(req)) as { id?: string };
        if (!payload.id) {
          jsonResponse(res, 400, { ok: false, error: 'id_required' });
          return;
        }
        const next = updateWebUiConfig((current) => {
          current.providers = current.providers.filter((p) => p.id !== payload.id);
          if (
            current.defaultProviderId === payload.id ||
            !current.providers.some((p) => p.id === current.defaultProviderId)
          ) {
            current.defaultProviderId = current.providers[0]?.id;
          }
          return current;
        });
        jsonResponse(res, 200, { ok: true, defaultProviderId: next.defaultProviderId || null });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/providers/set-default') {
        const payload = (await readJsonBody(req)) as { id?: string };
        if (!payload.id) {
          jsonResponse(res, 400, { ok: false, error: 'id_required' });
          return;
        }
        const next = updateWebUiConfig((current) => {
          if (!current.providers.some((p) => p.id === payload.id)) {
            throw new Error('provider_not_found');
          }
          current.defaultProviderId = payload.id;
          return current;
        });
        jsonResponse(res, 200, { ok: true, defaultProviderId: next.defaultProviderId });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/providers/models/refresh') {
        const payload = (await readJsonBody(req)) as { id?: string };
        const cfg = readWebUiConfig();
        const provider = getProviderById(cfg, payload.id);
        if (!provider) {
          jsonResponse(res, 404, { ok: false, error: 'provider_not_found' });
          return;
        }
        if (!provider.apiKey || !provider.baseUrl) {
          jsonResponse(res, 400, { ok: false, error: 'provider_not_ready' });
          return;
        }
        const models = await fetchModels(provider);
        updateWebUiConfig((current) => {
          const idx = current.providers.findIndex((p) => p.id === provider.id);
          if (idx >= 0) {
            current.providers[idx].models = models;
            if (!current.providers[idx].defaultModel && models[0]) {
              current.providers[idx].defaultModel = models[0];
            }
          }
          return current;
        });
        jsonResponse(res, 200, { ok: true, models });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/history') {
        const rows = getChatMessages(WEB_CHAT_JID, 60);
        jsonResponse(res, 200, {
          messages: rows.map((m) => ({
            role: m.is_bot_message ? 'assistant' : 'user',
            content: m.content,
            timestamp: m.timestamp,
          })),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJsonBody(req);
        await handleChat(body, res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/skills/search') {
        const q = url.searchParams.get('q') || '';
        jsonResponse(res, 200, { skills: searchSkillCatalog(q) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/skills/installed') {
        jsonResponse(res, 200, { skills: listInstalledSkills(process.cwd()) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/skills/install-local') {
        const body = (await readJsonBody(req)) as { sourcePath?: string };
        if (!body.sourcePath) {
          jsonResponse(res, 400, { ok: false, error: 'source_path_required' });
          return;
        }
        const output = installSkillFromLocalPath(process.cwd(), body.sourcePath);
        jsonResponse(res, 200, { ok: true, ...output });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/skills/install-git') {
        const body = (await readJsonBody(req)) as { repoUrl?: string; subPath?: string };
        if (!body.repoUrl) {
          jsonResponse(res, 400, { ok: false, error: 'repo_url_required' });
          return;
        }
        const output = installSkillFromGit(
          process.cwd(),
          body.repoUrl,
          body.subPath || '.claude/skills',
        );
        jsonResponse(res, 200, { ok: true, ...output });
        return;
      }

      jsonResponse(res, 404, { error: 'not_found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'invalid_json') {
        jsonResponse(res, 400, { error: 'invalid_json' });
        return;
      }
      if (message === 'payload_too_large') {
        jsonResponse(res, 413, { error: 'payload_too_large' });
        return;
      }
      if (message === 'provider_not_found') {
        jsonResponse(res, 404, { error: message });
        return;
      }
      logger.error({ err }, 'Unhandled webui request error');
      jsonResponse(res, 500, { error: message || 'internal_error' });
    }
  });
}

async function main(): Promise<void> {
  initDatabase();

  const groupDir = resolveGroupFolderPath(WEB_GROUP_FOLDER);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  ensurePresetProviders();

  const runtimeState: { ready: boolean; error?: string } = { ready: false };
  try {
    ensureContainerRuntimeRunning();
    cleanupOrphans();
    runtimeState.ready = true;
  } catch (err) {
    runtimeState.ready = false;
    runtimeState.error = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Container runtime is not ready');
  }

  const server = createServer(runtimeState);

  server.listen(WEBUI_PORT, () => {
    logger.info({ port: WEBUI_PORT }, 'NanoClaw WebUI listening');
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'WebUI failed to start');
  process.exit(1);
});
