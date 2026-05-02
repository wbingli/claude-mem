import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

// Maps Cursor stdin format - field names differ from Claude Code
// Cursor uses: conversation_id, workspace_roots[], result_json, command/output
// Handle undefined input gracefully for hooks that don't receive stdin
//
// Cursor payload variations (#838, #1049):
//   Session ID: conversation_id, generation_id, or id
//   Prompt: prompt, query, input, or message (varies by Cursor version/hook type)
//   CWD: workspace_roots[0] or cwd

/**
 * Derive the on-disk path to a Cursor agent transcript JSONL given the
 * workspace cwd and the conversation id. Cursor stores transcripts at:
 *
 *   ~/.cursor/projects/<workspace-slug>/agent-transcripts/<UUID>/<UUID>.jsonl
 *
 * where <workspace-slug> is the absolute cwd with the leading slash stripped
 * and any '/' or '.' replaced with '-' (e.g. /Users/foo.bar/workspaces ->
 * Users-foo-bar-workspaces). Returns undefined if the file does not exist.
 */
function deriveCursorTranscriptPath(cwd: string | undefined, sessionId: string | undefined): string | undefined {
  if (!cwd || !sessionId) return undefined;
  const slug = cwd.replace(/^\//, '').replace(/[/.]/g, '-');
  const candidate = join(homedir(), '.cursor', 'projects', slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
  return existsSync(candidate) ? candidate : undefined;
}

export const cursorAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    // Cursor-specific: shell commands come as command/output instead of tool_name/input/response
    const isShellCommand = !!r.command && !r.tool_name;
    // Plan 05 Phase 6 — cwd validation at the adapter boundary.
    const cwd = r.workspace_roots?.[0] ?? r.cwd ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const sessionId = r.conversation_id || r.generation_id || r.id;
    return {
      sessionId,
      cwd,
      prompt: r.prompt ?? r.query ?? r.input ?? r.message,
      toolName: isShellCommand ? 'Bash' : r.tool_name,
      toolInput: isShellCommand ? { command: r.command } : r.tool_input,
      toolResponse: isShellCommand ? { output: r.output } : r.result_json,  // result_json not tool_response
      // Cursor's stop hook does not pass a transcript path on stdin, but it
      // does write a JSONL transcript to disk under ~/.cursor/projects/...,
      // so we derive the path from cwd + conversation id.
      transcriptPath: deriveCursorTranscriptPath(cwd, sessionId),
      // Cursor-specific fields for file edits
      filePath: r.file_path,
      edits: r.edits,
    };
  },
  formatOutput(result) {
    // Cursor expects simpler response - just continue flag
    return { continue: result.continue ?? true };
  }
};
