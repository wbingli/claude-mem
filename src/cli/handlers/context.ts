/**
 * Context Handler - SessionStart
 *
 * Extracted from context-hook.ts - calls worker to generate context.
 * Returns context as hookSpecificOutput for Claude Code/Codex to inject.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback,
  isWorkerFallback,
  getWorkerPort,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';

function shouldUseHumanDisplay(platform: string | undefined): boolean {
  return platform === 'claude-code';
}

function isCodexPlatform(platform: string | undefined): boolean {
  return platform === 'codex' || platform === 'codex-cli';
}

function stripMarkdownHeading(line: string): string {
  return line.replace(/^#+\s*/, '').trim();
}

function formatCodexSystemMessage(additionalContext: string, port: number): string {
  return `${formatCodexContextSummary(additionalContext)} Viewer: http://localhost:${port}/`;
}

function formatCodexContextSummary(additionalContext: string): string {
  const lines = additionalContext
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const header = stripMarkdownHeading(lines[0] ?? 'claude-mem context loaded');
  const stats = lines.find(line => line.startsWith('Stats:'))?.replace(/^Stats:\s*/, '');
  const statsSuffix = stats ? `: ${stats}` : '';

  // Codex renders hook messages in a compact panel and currently collapses
  // newlines for both systemMessage and additionalContext. Keep startup context
  // intentionally one-line; detailed memory remains available via claude-mem
  // search/fetch tools instead of dumping a flattened 10KB wall into the UI.
  return `${header}${statsSuffix}. Use mem-search or get_observations([IDs]) for details.`;
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();
    const platform = input.platform;

    // Plan 05 Phase 4: settings via process-scope cache.
    const settings = loadFromFileOnce();
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    // Pass all projects (parent + worktree if applicable) for unified timeline
    const projectsParam = context.allProjects.join(',');
    const apiPath = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;
    const displayApiPath = shouldUseHumanDisplay(platform) ? `${apiPath}&colors=true` : apiPath;

    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    // Plan 05 Phase 2: single helper for ensure-worker-alive → request → fallback.
    const contextResult = await executeWithWorkerFallback<string>(apiPath, 'GET');
    if (isWorkerFallback(contextResult)) {
      return emptyResult;
    }

    let additionalContext: string;
    if (typeof contextResult === 'string') {
      additionalContext = contextResult.trim();
    } else if (contextResult === undefined) {
      additionalContext = '';
    } else {
      // Unexpected non-string body — log and fall back to empty.
      logger.warn('HOOK', 'Context response was not a string', { type: typeof contextResult });
      return emptyResult;
    }

    let terminalDisplay = '';
    if (showTerminalOutput) {
      if (isCodexPlatform(platform)) {
        terminalDisplay = formatCodexSystemMessage(additionalContext, port);
      } else {
        const displayResult = await executeWithWorkerFallback<string>(displayApiPath, 'GET');
        if (!isWorkerFallback(displayResult) && typeof displayResult === 'string') {
          terminalDisplay = displayResult.trim();
        }
      }
    }

    // Use terminal-friendly context for display if available, otherwise fall
    // back to plain markdown for platforms where the visible message is the
    // only confirmation that context was loaded.
    const displayContent = terminalDisplay || (platform === 'gemini-cli' || platform === 'gemini' ? additionalContext : '');

    const injectedContext = isCodexPlatform(platform) && additionalContext
      ? formatCodexContextSummary(additionalContext)
      : additionalContext;

    const systemMessage = showTerminalOutput && displayContent
      ? isCodexPlatform(platform)
        ? displayContent
        : `${displayContent}\n\nView Observations Live @ http://localhost:${port}`
      : undefined;

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: injectedContext
      },
      systemMessage
    };
  }
};
