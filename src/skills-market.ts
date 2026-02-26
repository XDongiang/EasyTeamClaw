import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface SkillCatalogEntry {
  id: string;
  name: string;
  summary: string;
  source: string;
  repoPath?: string;
}

const CATALOG: SkillCatalogEntry[] = [
  {
    id: 'setup',
    name: '/setup',
    summary: 'Initial setup workflow and environment checks',
    source: 'builtin',
  },
  {
    id: 'customize',
    name: '/customize',
    summary: 'Guided customization for channels and behavior',
    source: 'builtin',
  },
  {
    id: 'debug',
    name: '/debug',
    summary: 'Troubleshooting and recovery flow',
    source: 'builtin',
  },
  {
    id: 'update',
    name: '/update',
    summary: 'Update from upstream with migration support',
    source: 'builtin',
  },
  {
    id: 'add-telegram',
    name: '/add-telegram',
    summary: 'Add Telegram channel support',
    source: 'builtin',
  },
  {
    id: 'add-slack',
    name: '/add-slack',
    summary: 'Add Slack channel support',
    source: 'builtin',
  },
  {
    id: 'add-discord',
    name: '/add-discord',
    summary: 'Add Discord channel support',
    source: 'builtin',
  },
  {
    id: 'add-gmail',
    name: '/add-gmail',
    summary: 'Add Gmail integration',
    source: 'builtin',
  },
];

function getSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'skills');
}

export function searchSkillCatalog(query: string): SkillCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return CATALOG;
  return CATALOG.filter(
    (entry) =>
      entry.id.toLowerCase().includes(q) ||
      entry.name.toLowerCase().includes(q) ||
      entry.summary.toLowerCase().includes(q),
  );
}

export function listInstalledSkills(projectRoot: string): string[] {
  const skillsDir = getSkillsDir(projectRoot);
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir)
    .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
    .sort();
}

export function installSkillFromLocalPath(
  projectRoot: string,
  sourcePath: string,
): { installed: string[]; skipped: string[] } {
  const skillsDir = getSkillsDir(projectRoot);
  fs.mkdirSync(skillsDir, { recursive: true });

  const absSource = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(projectRoot, sourcePath);

  if (!fs.existsSync(absSource)) {
    throw new Error(`source_not_found:${absSource}`);
  }

  const entries = fs
    .readdirSync(absSource)
    .filter((name) => fs.existsSync(path.join(absSource, name, 'SKILL.md')));

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const from = path.join(absSource, entry);
    const to = path.join(skillsDir, entry);
    if (fs.existsSync(to)) {
      skipped.push(entry);
      continue;
    }
    fs.cpSync(from, to, { recursive: true });
    installed.push(entry);
  }

  return { installed, skipped };
}

export function installSkillFromGit(
  projectRoot: string,
  repoUrl: string,
  subPath = '.claude/skills',
): { installed: string[]; skipped: string[] } {
  const tempDir = fs.mkdtempSync(path.join(projectRoot, 'tmp-skill-'));
  try {
    execSync(`git clone --depth=1 ${JSON.stringify(repoUrl)} ${JSON.stringify(tempDir)}`, {
      stdio: 'pipe',
    });
    const sourcePath = path.join(tempDir, subPath);
    return installSkillFromLocalPath(projectRoot, sourcePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
