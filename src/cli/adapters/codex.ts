import type { PlatformAdapter, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

// Defensive cap mirroring the Claude Code adapter — Codex tool names like
// "Bash", "apply_patch", or MCP-prefixed identifiers are short. Anything
// significantly longer than 128 chars is almost certainly malformed.
const MAX_AGENT_FIELD_LEN = 128;
const pickField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

/**
 * Codex CLI hook adapter.
 *
 * Codex hook stdin (per https://developers.openai.com/codex/hooks):
 *   common: { session_id, transcript_path, cwd, hook_event_name, model, turn_id? }
 *   SessionStart adds:   source ("startup" | "resume" | "clear")
 *   PreToolUse / PostToolUse adds:  tool_name, tool_use_id, tool_input, tool_response
 *   UserPromptSubmit adds: prompt
 *   Stop adds:           stop_hook_active, last_assistant_message
 *
 * Output: SessionStart and UserPromptSubmit may return
 *   { hookSpecificOutput: { hookEventName, additionalContext } }
 * which Codex injects as developer context — equivalent to Claude Code.
 */
export const codexAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = (r.cwd as string | undefined) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId =
      (r.session_id as string | undefined) ??
      (r.sessionId as string | undefined) ??
      (r.id as string | undefined);

    return {
      sessionId: sessionId ?? '',
      cwd,
      prompt: r.prompt as string | undefined,
      toolName: pickField(r.tool_name) ?? pickField(r.toolName),
      toolInput: r.tool_input ?? r.toolInput,
      toolResponse: r.tool_response ?? r.toolResponse,
      transcriptPath: (r.transcript_path as string | undefined) ?? (r.transcriptPath as string | undefined),
      lastAssistantMessage:
        (r.last_assistant_message as string | undefined) ?? (r.lastAssistantMessage as string | undefined),
      metadata: {
        hookEventName: r.hook_event_name ?? r.hookEventName,
        source: r.source,
        turnId: r.turn_id ?? r.turnId,
        model: r.model,
      },
    };
  },
  formatOutput(result) {
    const r = result ?? ({} as HookResult);

    // Codex labels a PostToolUse hook "Failed" when it returns an unrecognised
    // JSON shape. Our handler reports {continue, suppressOutput} on success
    // (a Claude Code idiom) which is meaningless for Codex's PostToolUse and
    // triggers a noisy "Failed" badge in the CLI. When we have nothing
    // additive to say, emit no JSON at all — Codex treats "exit 0 with no
    // output" as success.
    if (r.hookSpecificOutput) {
      const output: Record<string, unknown> = { hookSpecificOutput: r.hookSpecificOutput };
      if (r.systemMessage) output.systemMessage = r.systemMessage;
      return output;
    }

    if (r.systemMessage) {
      return { systemMessage: r.systemMessage };
    }

    // No additive output → return null sentinel; hook-command writes nothing.
    return null;
  },
};
