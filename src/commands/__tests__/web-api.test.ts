import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempHome(): string {
  const root = join('/tmp', `neoclaw-web-api-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tmpDirs.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

async function waitForServer(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

function parseCsrf(setCookieHeader: string | null): string {
  const match = setCookieHeader?.match(/csrf-token=([^;]+)/);
  if (!match) throw new Error('csrf cookie not found');
  return match[1];
}

describe('web API integration', () => {
  it('serves cron and skills APIs over the real web process', async () => {
    const home = createTempHome();
    const baseDir = join(home, '.neoclaw-it');
    const workspace = join(home, 'workspace');
    const port = 3300 + Math.floor(Math.random() * 400);
    const baseUrl = `http://127.0.0.1:${port}`;

    mkdirSync(baseDir, { recursive: true });
    mkdirSync(join(workspace, 'skills', 'demo-skill'), { recursive: true });
    mkdirSync(join(workspace, 'skills', 'notes-skill'), { recursive: true });
    mkdirSync(join(workspace, '..', 'data', 'cron'), { recursive: true });

    writeFileSync(join(baseDir, 'config.json'), JSON.stringify({
      agent: {
        model: 'openai:gpt-4o',
        codeModel: 'openai:gpt-4o-mini',
        memoryWindow: 50,
        workspace,
        maxMemorySize: 8192,
        consolidationTimeout: 30000,
        subagentTimeout: 0,
      },
      channels: {
        telegram: { enabled: false, token: '', allowFrom: [] },
        cli: { enabled: true },
        dingtalk: { enabled: false, clientId: '', clientSecret: '', robotCode: '', allowFrom: [] },
        feishu: { enabled: false, appId: '', appSecret: '', allowFrom: [], connectionMode: 'websocket' },
      },
      providers: {},
      logLevel: 'info',
    }, null, 2), 'utf-8');

    writeFileSync(join(workspace, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: Demo Skill\ndescription: Demo skill\n---\nUse demo skill.', 'utf-8');
    writeFileSync(join(workspace, 'skills', 'notes-skill', 'SKILL.md'), '---\nname: Notes Skill\ndescription: Notes helper\n---\nTake notes.', 'utf-8');
    writeFileSync(join(workspace, '..', 'data', 'cron', 'jobs.json'), JSON.stringify([
      {
        id: 'job-a',
        type: 'every',
        schedule: 120,
        payload: { message: 'tick', channel: 'cli', chatId: 'cli' },
        enabled: true,
      },
    ], null, 2), 'utf-8');

    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'web', '--profile', 'it', '--token', 'apitest', '--port', String(port)], {
      cwd: '/Users/xiaobei/Documents/xiaobei/neoclaw',
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      await waitForServer(baseUrl, 60_000);

      const authHeaders = { Authorization: 'Bearer apitest' };
      const bootstrap = await fetch(`${baseUrl}/api/config/current`, { headers: authHeaders });
      expect(bootstrap.status).toBe(200);
      const csrf = parseCsrf(bootstrap.headers.get('set-cookie'));
      const stateHeaders = {
        ...authHeaders,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      };

      const chatCreate = await fetch(`${baseUrl}/api/chat/sessions`, {
        method: 'POST',
        headers: stateHeaders,
        body: JSON.stringify({}),
      });
      const chatCreateJson = await chatCreate.json() as { session: { id: string; messages: unknown[] } };
      expect(chatCreate.status).toBe(200);
      expect(chatCreateJson.session.id.startsWith('webchat:')).toBe(true);
      expect(chatCreateJson.session.messages).toHaveLength(0);

      const chatList = await fetch(`${baseUrl}/api/chat/sessions`, { headers: authHeaders });
      const chatListJson = await chatList.json() as { sessions: Array<{ id: string }> };
      expect(chatList.status).toBe(200);
      expect(chatListJson.sessions.some((session) => session.id === chatCreateJson.session.id)).toBe(true);

      const chatDetail = await fetch(`${baseUrl}/api/chat/sessions/${encodeURIComponent(chatCreateJson.session.id)}`, { headers: authHeaders });
      const chatDetailJson = await chatDetail.json() as { session: { id: string; messages: unknown[] } };
      expect(chatDetail.status).toBe(200);
      expect(chatDetailJson.session.id).toBe(chatCreateJson.session.id);
      expect(chatDetailJson.session.messages).toHaveLength(0);

      const chatEmptyMessage = await fetch(`${baseUrl}/api/chat/sessions/${encodeURIComponent(chatCreateJson.session.id)}/messages`, {
        method: 'POST',
        headers: stateHeaders,
        body: JSON.stringify({ message: '' }),
      });
      expect(chatEmptyMessage.status).toBe(400);

      const chatClear = await fetch(`${baseUrl}/api/chat/sessions/${encodeURIComponent(chatCreateJson.session.id)}/clear`, {
        method: 'POST',
        headers: { Authorization: 'Bearer apitest', 'X-CSRF-Token': csrf },
      });
      const chatClearJson = await chatClear.json() as { session: { messages: unknown[] } };
      expect(chatClear.status).toBe(200);
      expect(chatClearJson.session.messages).toHaveLength(0);

      const cronList = await fetch(`${baseUrl}/api/cron/jobs`, { headers: authHeaders });
      const cronListJson = await cronList.json() as { jobs: Array<{ id: string; nextRunPreview?: string }> };
      expect(cronList.status).toBe(200);
      expect(cronListJson.jobs).toHaveLength(1);
      expect(cronListJson.jobs[0]?.id).toBe('job-a');
      expect(typeof cronListJson.jobs[0]?.nextRunPreview).toBe('string');

      const cronCreate = await fetch(`${baseUrl}/api/cron/jobs`, {
        method: 'POST',
        headers: stateHeaders,
        body: JSON.stringify({ type: 'cron', schedule: '0 9 * * 1-5', message: 'weekday report', channel: 'cli', chatId: 'cli' }),
      });
      const cronCreateJson = await cronCreate.json() as { job: { id: string; enabled: boolean } };
      expect(cronCreate.status).toBe(200);
      expect(cronCreateJson.job.enabled).toBe(true);

      const pauseRes = await fetch(`${baseUrl}/api/cron/jobs/${cronCreateJson.job.id}/pause`, {
        method: 'POST',
        headers: { Authorization: 'Bearer apitest', 'X-CSRF-Token': csrf },
      });
      expect(pauseRes.status).toBe(200);

      const resumeRes = await fetch(`${baseUrl}/api/cron/jobs/${cronCreateJson.job.id}/resume`, {
        method: 'POST',
        headers: { Authorization: 'Bearer apitest', 'X-CSRF-Token': csrf },
      });
      expect(resumeRes.status).toBe(200);

      const skillsRes = await fetch(`${baseUrl}/api/skills/local`, { headers: authHeaders });
      const skillsJson = await skillsRes.json() as { skills: Array<{ dirName: string; name: string }> };
      expect(skillsRes.status).toBe(200);
      expect(skillsJson.skills.map((skill) => skill.dirName)).toEqual(['demo-skill', 'notes-skill']);

      const skillDetailRes = await fetch(`${baseUrl}/api/skills/demo-skill`, { headers: authHeaders });
      const skillDetailJson = await skillDetailRes.json() as { skill: { name: string; content: string } };
      expect(skillDetailRes.status).toBe(200);
      expect(skillDetailJson.skill.name).toBe('Demo Skill');
      expect(skillDetailJson.skill.content).toContain('Use demo skill.');

      const deleteSkillRes = await fetch(`${baseUrl}/api/skills/demo-skill`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer apitest', 'X-CSRF-Token': csrf },
      });
      expect(deleteSkillRes.status).toBe(200);

      const skillsAfterDelete = await fetch(`${baseUrl}/api/skills/local`, { headers: authHeaders });
      const skillsAfterDeleteJson = await skillsAfterDelete.json() as { skills: Array<{ dirName: string }> };
      expect(skillsAfterDeleteJson.skills.map((skill) => skill.dirName)).toEqual(['notes-skill']);

      const deleteChatRes = await fetch(`${baseUrl}/api/chat/sessions/${encodeURIComponent(chatCreateJson.session.id)}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer apitest', 'X-CSRF-Token': csrf },
      });
      expect(deleteChatRes.status).toBe(200);

      const chatListAfterDelete = await fetch(`${baseUrl}/api/chat/sessions`, { headers: authHeaders });
      const chatListAfterDeleteJson = await chatListAfterDelete.json() as { sessions: Array<{ id: string }> };
      expect(chatListAfterDeleteJson.sessions.some((session) => session.id === chatCreateJson.session.id)).toBe(false);

      const deleteCronRes = await fetch(`${baseUrl}/api/cron/jobs/${cronCreateJson.job.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer apitest', 'X-CSRF-Token': csrf },
      });
      expect(deleteCronRes.status).toBe(200);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 120_000);
});
