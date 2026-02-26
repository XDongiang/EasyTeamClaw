/**
 * Step: service — Generate and load service manager config.
 * Supports core runtime service and webui runtime service.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import { getPlatform, getNodePath, getServiceManager, isRoot } from './platform.js';
import { emitStatus } from './status.js';

type ServiceTarget = 'core' | 'webui';

interface ServiceOptions {
  target: ServiceTarget;
  serviceName: string;
  entrypoint: string;
  webuiPort?: string;
}

function parseArgs(args: string[]): ServiceOptions {
  let target: ServiceTarget = 'core';
  let serviceName = '';
  let webuiPort: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) {
      const t = args[i + 1];
      if (t === 'webui' || t === 'core') target = t;
      i++;
      continue;
    }
    if (args[i] === '--service-name' && args[i + 1]) {
      serviceName = args[i + 1];
      i++;
      continue;
    }
    if (args[i] === '--webui-port' && args[i + 1]) {
      webuiPort = args[i + 1];
      i++;
      continue;
    }
  }

  if (!serviceName) {
    serviceName = target === 'webui' ? 'easyteamclaw-webui' : 'nanoclaw';
  }

  const entrypoint = target === 'webui' ? 'dist/webui.js' : 'dist/index.js';

  return {
    target,
    serviceName,
    entrypoint,
    webuiPort,
  };
}

function sanitizeServiceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();
  const opts = parseArgs(args);

  opts.serviceName = sanitizeServiceName(opts.serviceName);

  logger.info({ platform, nodePath, projectRoot, opts }, 'Setting up service');

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      TARGET: opts.target,
      SERVICE_NAME: opts.serviceName,
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir, opts);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, nodePath, homeDir, opts);
  } else {
    emitStatus('SETUP_SERVICE', {
      TARGET: opts.target,
      SERVICE_NAME: opts.serviceName,
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

function launchdLabel(serviceName: string): string {
  return `com.${serviceName}`;
}

function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  opts: ServiceOptions,
): void {
  const label = launchdLabel(opts.serviceName);
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const envLines = [
    '        <key>PATH</key>',
    `        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>`,
    '        <key>HOME</key>',
    `        <string>${homeDir}</string>`,
  ];
  if (opts.target === 'webui' && opts.webuiPort) {
    envLines.push('        <key>WEBUI_PORT</key>');
    envLines.push(`        <string>${opts.webuiPort}</string>`);
  }

  const logPrefix = opts.serviceName;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/${opts.entrypoint}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
${envLines.join('\n')}
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/${logPrefix}.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/${logPrefix}.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath, label }, 'Wrote launchd plist');

  try {
    execSync(`launchctl unload ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
  } catch {
    // already unloaded
  }

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info('launchctl load succeeded');
  } catch (err) {
    logger.warn({ err }, 'launchctl load failed');
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes(label);
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    TARGET: opts.target,
    SERVICE_NAME: opts.serviceName,
    SERVICE_LABEL: label,
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    ENTRYPOINT: opts.entrypoint,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  opts: ServiceOptions,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, nodePath, homeDir, opts);
  } else {
    setupNohupFallback(projectRoot, nodePath, opts);
  }
}

function killOrphanedProcesses(projectRoot: string, entrypoint: string): void {
  const safe = entrypoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    execSync(`pkill -f '${projectRoot}/${safe}' || true`, {
      stdio: 'ignore',
    });
    logger.info({ entrypoint }, 'Stopped orphaned node processes');
  } catch {
    // ignore
  }
}

function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false;
  } catch {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  opts: ServiceOptions,
): void {
  const runningAsRoot = isRoot();

  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = `/etc/systemd/system/${opts.serviceName}.service`;
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, nodePath, opts);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, `${opts.serviceName}.service`);
    systemctlPrefix = 'systemctl --user';
  }

  const envLines = [
    `Environment=HOME=${homeDir}`,
    `Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`,
  ];
  if (opts.target === 'webui' && opts.webuiPort) {
    envLines.push(`Environment=WEBUI_PORT=${opts.webuiPort}`);
  }

  const logPrefix = opts.serviceName;
  const unit = `[Unit]
Description=EasyTeamClaw ${opts.target === 'webui' ? 'WebUI' : 'Core'} Service
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/${opts.entrypoint}
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
${envLines.join('\n')}
StandardOutput=append:${projectRoot}/logs/${logPrefix}.log
StandardError=append:${projectRoot}/logs/${logPrefix}.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote systemd unit');

  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    logger.warn(
      'Docker group not active in systemd session — user was likely added to docker group mid-session',
    );
  }

  killOrphanedProcesses(projectRoot, opts.entrypoint);

  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable ${opts.serviceName}`, {
      stdio: 'ignore',
    });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} restart ${opts.serviceName}`, {
      stdio: 'ignore',
    });
  } catch (err) {
    logger.error({ err }, 'systemctl restart failed');
  }

  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active ${opts.serviceName}`, {
      stdio: 'ignore',
    });
    serviceLoaded = true;
  } catch {
    // not active
  }

  emitStatus('SETUP_SERVICE', {
    TARGET: opts.target,
    SERVICE_NAME: opts.serviceName,
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    ENTRYPOINT: opts.entrypoint,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  opts: ServiceOptions,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const wrapperName = `start-${opts.serviceName}.sh`;
  const wrapperPath = path.join(projectRoot, wrapperName);
  const pidFile = path.join(projectRoot, `${opts.serviceName}.pid`);

  const envPrefix =
    opts.target === 'webui' && opts.webuiPort
      ? `WEBUI_PORT=${JSON.stringify(opts.webuiPort)} `
      : '';

  const lines = [
    '#!/bin/bash',
    `# ${wrapperName} — Start ${opts.serviceName} without systemd`,
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    `    echo "Stopping existing ${opts.serviceName} (PID $OLD_PID)..."`,
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    `echo "Starting ${opts.serviceName}..."`,
    `nohup ${envPrefix}${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/' + opts.entrypoint)} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/' + opts.serviceName + '.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/' + opts.serviceName + '.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    `echo "${opts.serviceName} started (PID $!)"`,
    `echo "Logs: tail -f ${projectRoot}/logs/${opts.serviceName}.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    TARGET: opts.target,
    SERVICE_NAME: opts.serviceName,
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    ENTRYPOINT: opts.entrypoint,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
