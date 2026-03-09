import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SkillManager } from '../skill-manager.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function createWorkspace(): string {
  const root = join('/tmp', `neoclaw-skill-manager-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tmpDirs.push(root);
  mkdirSync(join(root, 'skills'), { recursive: true });
  return root;
}

function writeSkill(workspace: string, dirName: string, body: string): void {
  const dir = join(workspace, 'skills', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
}

describe('SkillManager', () => {
  it('lists detail payloads for local skills', async () => {
    const workspace = createWorkspace();
    writeSkill(workspace, 'weather', '---\nname: Weather\ndescription: Forecast helper\n---\nUse this skill for weather.');

    const manager = new SkillManager(workspace);
    const details = await manager.getSkillDetails();

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      dirName: 'weather',
      name: 'Weather',
      description: 'Forecast helper',
      relativePath: 'skills/weather/SKILL.md',
    });
    expect(details[0]?.content).toContain('Use this skill for weather.');
  });

  it('resolves and deletes skills by dir name', async () => {
    const workspace = createWorkspace();
    writeSkill(workspace, 'cron', '---\nname: Cron\ndescription: Schedules tasks\n---\nRun /cron.');

    const manager = new SkillManager(workspace);
    expect(await manager.hasSkill('cron')).toBe(true);

    const detail = await manager.getSkillDetail('cron');
    expect(detail?.name).toBe('Cron');

    const removed = await manager.deleteSkill('cron');
    expect(removed).toBe(true);
    expect(await manager.hasSkill('cron')).toBe(false);
  });

  it('resolves skill commands with arguments', async () => {
    const workspace = createWorkspace();
    writeSkill(workspace, 'greet', '---\nname: greet\ndescription: Greeting helper\n---\nHello $1 from $ARGUMENTS');

    const manager = new SkillManager(workspace);
    const resolved = await manager.resolveSkillCommand('/greet world from neoclaw');

    expect(resolved).toContain('Base directory for this skill:');
    expect(resolved).toContain('Hello world from world from neoclaw');
  });
});
