/**
 * Step: verify — End-to-end health check.
 * Supports full mode and webui mode with dedicated service names.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { readWebUiConfig } from '../src/web-config.js';
import { getServiceManager, isRoot } from './platform.js';
import { emitStatus } from './status.js';

interface VerifyOptions {
  mode: 'full' | 'webui';
  serviceName: string;
}

function parseArgs(args: string[]): VerifyOptions {
  let mode: 'full' | 'webui' = 'full';
  let serviceName = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const val = args[i + 1];
      if (val === 'webui' || val === 'full') mode = val;
      i++;
      continue;
    }
    if (args[i] === '--service-name' && args[i + 1]) {
      serviceName = args[i + 1];
      i++;
      continue;
    }
  }

  if (!serviceName) {
    serviceName = mode === 'webui' ? 'easyteamclaw-webui' : 'nanoclaw';
  }

  return { mode, serviceName };
}

function serviceLabel(serviceName: string): string {
  return `com.${serviceName}`;
}

function detectServiceStatus(projectRoot: string, serviceName: string): string {
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const label = serviceLabel(serviceName);
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      if (output.includes(label)) {
        const line = output.split('\n').find((l) => l.includes(label));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active ${serviceName}`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes(serviceName)) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available
      }
    }
  } else {
    const pidFile = path.join(projectRoot, `${serviceName}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        if (pid) {
          execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }

  return service;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { mode, serviceName } = parseArgs(args);
  const homeDir = os.homedir();

  logger.info({ mode, serviceName }, 'Starting verification');

  const service = detectServiceStatus(projectRoot, serviceName);
  logger.info({ service }, 'Service status');

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('command -v container', { stdio: 'ignore' });
    containerRuntime = 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore' });
      containerRuntime = 'docker';
    } catch {
      // No runtime
    }
  }

  // 3. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }
  const webConfig = readWebUiConfig();
  const webUiConfig = webConfig.providers.some((p) => !!p.apiKey)
    ? 'configured'
    : 'missing';
  if (credentials === 'missing' && webUiConfig === 'configured') {
    credentials = 'configured';
  }

  // 4. Check WhatsApp auth
  let whatsappAuth = 'not_found';
  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    whatsappAuth = 'authenticated';
  }

  // 5. Check registered groups
  let registeredGroups = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroups = row.count;
      db.close();
    } catch {
      // Table might not exist
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // 7. Check WebUI build artifacts
  const webUiBuild =
    fs.existsSync(path.join(projectRoot, 'dist', 'webui.js')) &&
    fs.existsSync(path.join(projectRoot, 'dist', 'web-config.js')) &&
    fs.existsSync(path.join(projectRoot, 'dist', 'skills-market.js'))
      ? 'present'
      : 'missing';

  const status =
    mode === 'webui'
      ? service === 'running' &&
        containerRuntime !== 'none' &&
        credentials !== 'missing' &&
        mountAllowlist !== 'missing' &&
        webUiBuild === 'present'
        ? 'success'
        : 'failed'
      : service === 'running' &&
          credentials !== 'missing' &&
          whatsappAuth !== 'not_found' &&
          registeredGroups > 0
        ? 'success'
        : 'failed';

  logger.info({ status }, 'Verification complete');

  emitStatus('VERIFY', {
    MODE: mode,
    SERVICE_NAME: serviceName,
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    WEBUI_CONFIG: webUiConfig,
    WEBUI_BUILD: webUiBuild,
    WHATSAPP_AUTH: whatsappAuth,
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
