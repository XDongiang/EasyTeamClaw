/**
 * Step: webui — Build and validate local WebUI mode.
 * Ensures the web entrypoint compiles and required runtime files exist.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function runtimeAvailable(): 'apple-container' | 'docker' | 'none' {
  try {
    execSync('command -v container', { stdio: 'ignore' });
    return 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore' });
      return 'docker';
    } catch {
      return 'none';
    }
  }
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const runtime = runtimeAvailable();
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (!fs.existsSync(path.join(projectRoot, 'src', 'webui.ts'))) {
    emitStatus('SETUP_WEBUI', {
      RUNTIME: runtime,
      BUILD_OK: false,
      ENTRYPOINT_OK: false,
      STATUS: 'failed',
      ERROR: 'missing_src_webui',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  let buildOk = false;
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
  } catch (err) {
    logger.error({ err }, 'WebUI build failed');
  }

  const webEntry = path.join(projectRoot, 'dist', 'webui.js');
  const configEntry = path.join(projectRoot, 'dist', 'web-config.js');
  const skillsMarketEntry = path.join(projectRoot, 'dist', 'skills-market.js');
  const entrypointOk =
    fs.existsSync(webEntry) &&
    fs.existsSync(configEntry) &&
    fs.existsSync(skillsMarketEntry);

  // Syntax check only; runtime check is performed by /api/status when started.
  let syntaxOk = false;
  if (entrypointOk) {
    try {
      execSync(`node --check ${JSON.stringify(webEntry)}`, { stdio: 'ignore' });
      syntaxOk = true;
    } catch {
      syntaxOk = false;
    }
  }

  const status =
    runtime !== 'none' && buildOk && entrypointOk && syntaxOk
      ? 'success'
      : 'failed';

  emitStatus('SETUP_WEBUI', {
    RUNTIME: runtime,
    BUILD_OK: buildOk,
    ENTRYPOINT_OK: entrypointOk,
    SYNTAX_OK: syntaxOk,
    WEB_ENTRY: path.relative(projectRoot, webEntry),
    STATUS: status,
    LOG: path.relative(projectRoot, logFile),
  });

  if (status === 'failed') process.exit(1);
}
