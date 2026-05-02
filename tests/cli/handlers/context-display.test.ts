import { describe, it, expect, mock, beforeEach } from 'bun:test';

const requests: string[] = [];

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
  isWorkerFallback: (value: unknown) => value && typeof value === 'object' && (value as any).__workerFallback === true,
  executeWithWorkerFallback: mock(async (apiPath: string) => {
    requests.push(apiPath);
    if (apiPath.includes('colors=true')) {
      return '\u001b[36m[claude-mem] recent context\u001b[0m\n\u001b[2mContext Economics\u001b[0m';
    }
    return '# [claude-mem] recent context\n\nStats: 50 obs';
  }),
}));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'claude-mem',
    allProjects: ['claude-mem'],
  }),
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
  }),
}));

import { contextHandler } from '../../../src/cli/handlers/context.js';

beforeEach(() => {
  requests.length = 0;
});

describe('contextHandler terminal display formatting', () => {
  it('uses a one-line Codex display while keeping compact injected context', async () => {
    const result = await contextHandler.execute({
      sessionId: 'codex-session',
      cwd: '/tmp/claude-mem',
      platform: 'codex',
    });

    expect(requests).toEqual([
      '/api/context/inject?projects=claude-mem',
    ]);
    const expected = '[claude-mem] recent context: 50 obs. Use mem-search or get_observations([IDs]) for details.';
    expect(result.hookSpecificOutput?.additionalContext).toBe(expected);
    expect(result.systemMessage).toBe(`${expected} Viewer: http://localhost:37777/`);
  });

  it('keeps ANSI color codes for Claude Code terminal display', async () => {
    const result = await contextHandler.execute({
      sessionId: 'claude-session',
      cwd: '/tmp/claude-mem',
      platform: 'claude-code',
    });

    expect(result.systemMessage).toContain('\u001b[36m[claude-mem] recent context\u001b[0m');
  });
});
