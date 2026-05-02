/**
 * CodexHooksInstaller - Native Codex CLI hooks integration for claude-mem.
 *
 * Replaces the transcript-watcher path with Codex's native hook lifecycle
 * (https://developers.openai.com/codex/hooks). Hooks are merged into
 * `~/.codex/hooks.json` and the `codex_hooks` feature flag is ensured in
 * `~/.codex/config.toml`. All four lifecycle events route through the
 * unified `worker-service.cjs hook codex <event>` pipeline.
 *
 * Events registered:
 *   SessionStart      → context           (returns hookSpecificOutput.additionalContext)
 *   UserPromptSubmit  → session-init      (records prompt + injects semantic context)
 *   PostToolUse       → observation       (captures tool output)
 *   Stop              → summarize         (queues session summary)
 *
 * Anti-patterns intentionally avoided:
 *   - Does NOT write to <workspace>/AGENTS.md (the whole point of #2249).
 *   - Does NOT remove or interfere with the transcript watcher install — the
 *     two paths can coexist and the watcher remains as a fallback for older
 *     Codex versions without `codex_hooks`.
 *   - Does NOT touch user-defined hook entries; merging is keyed on a stable
 *     marker so re-installs and uninstalls only affect claude-mem entries.
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findBunPath, findWorkerServicePath } from './CursorHooksInstaller.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodexHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookEntry[];
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_DIR = path.join(homedir(), '.codex');
const CODEX_HOOKS_PATH = path.join(CODEX_DIR, 'hooks.json');
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, 'config.toml');
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, 'AGENTS.md');

// Stable marker embedded in every claude-mem hook command so we can
// idempotently merge/remove our entries without disturbing user-defined hooks.
const CLAUDE_MEM_MARKER = '#claude-mem';

const HOOK_TIMEOUT_SECONDS = 60;
const STOP_HOOK_TIMEOUT_SECONDS = 120;

const CODEX_EVENT_TO_INTERNAL_EVENT: Record<string, { event: string; timeout: number; matcher?: string }> = {
  SessionStart:     { event: 'context',       timeout: HOOK_TIMEOUT_SECONDS, matcher: 'startup|resume|clear' },
  UserPromptSubmit: { event: 'session-init',  timeout: HOOK_TIMEOUT_SECONDS },
  PostToolUse:      { event: 'observation',   timeout: HOOK_TIMEOUT_SECONDS, matcher: '*' },
  Stop:             { event: 'summarize',     timeout: STOP_HOOK_TIMEOUT_SECONDS },
};

// ---------------------------------------------------------------------------
// Hook Command Builder
// ---------------------------------------------------------------------------

/**
 * Build the shell command that Codex invokes for a given hook event.
 *
 * Codex runs commands with the session cwd; we need to make sure the worker
 * is reachable on stdin/stdout. The command embeds CLAUDE_MEM_MARKER so we
 * can recognise our entries when merging into a pre-existing hooks.json.
 */
function buildHookCommand(bunPath: string, workerServicePath: string, internalEvent: string): string {
  const escapedBun = bunPath.replace(/"/g, '\\"');
  const escapedWorker = workerServicePath.replace(/"/g, '\\"');
  return `"${escapedBun}" "${escapedWorker}" hook codex ${internalEvent} ${CLAUDE_MEM_MARKER}`;
}

// ---------------------------------------------------------------------------
// hooks.json Merge Logic
// ---------------------------------------------------------------------------

function readHooksJson(): CodexHooksFile {
  if (!existsSync(CODEX_HOOKS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CODEX_HOOKS_PATH, 'utf-8')) as CodexHooksFile;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Corrupt JSON in Codex hooks.json', { path: CODEX_HOOKS_PATH }, error);
    } else {
      logger.error('WORKER', 'Corrupt JSON in Codex hooks.json', { path: CODEX_HOOKS_PATH }, new Error(String(error)));
    }
    throw new Error(`Corrupt JSON in ${CODEX_HOOKS_PATH}, refusing to overwrite user file`);
  }
}

function writeHooksJson(file: CodexHooksFile): void {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(CODEX_HOOKS_PATH, JSON.stringify(file, null, 2) + '\n');
}

function isClaudeMemHookEntry(entry: CodexHookEntry): boolean {
  return typeof entry.command === 'string' && entry.command.includes(CLAUDE_MEM_MARKER);
}

function pruneClaudeMemEntries(groups: CodexHookGroup[]): CodexHookGroup[] {
  return groups
    .map(g => ({
      ...g,
      hooks: (g.hooks ?? []).filter(h => !isClaudeMemHookEntry(h)),
    }))
    .filter(g => g.hooks.length > 0);
}

function mergeClaudeMemHooks(file: CodexHooksFile, bunPath: string, workerServicePath: string): CodexHooksFile {
  const merged: CodexHooksFile = { ...file };
  merged.hooks = { ...(merged.hooks ?? {}) };

  for (const [codexEvent, mapping] of Object.entries(CODEX_EVENT_TO_INTERNAL_EVENT)) {
    const command = buildHookCommand(bunPath, workerServicePath, mapping.event);

    const newGroup: CodexHookGroup = {
      hooks: [{ type: 'command', command, timeout: mapping.timeout }],
    };
    if (mapping.matcher !== undefined) {
      newGroup.matcher = mapping.matcher;
    }

    const existing = merged.hooks[codexEvent] ?? [];
    const pruned = pruneClaudeMemEntries(existing);
    merged.hooks[codexEvent] = [...pruned, newGroup];
  }

  return merged;
}

// ---------------------------------------------------------------------------
// config.toml: enable [features] codex_hooks = true
// ---------------------------------------------------------------------------

/**
 * Idempotently ensure `[features] codex_hooks = true` is present in
 * `~/.codex/config.toml`. The TOML parser landscape on Node is fragile and
 * we intentionally avoid pulling a dep just for one-line edits — the regex
 * approach below is sufficient for the well-known Codex layout (a single
 * `[features]` section with simple boolean entries) and is non-destructive
 * for any other content in the file.
 */
function ensureCodexHooksFeatureFlag(): { changed: boolean; alreadyEnabled: boolean } {
  let original = '';
  if (existsSync(CODEX_CONFIG_PATH)) {
    original = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  }

  const featuresHeader = /^\s*\[features\]\s*$/m;
  const codexHooksLine = /^\s*codex_hooks\s*=\s*(true|false)\s*$/m;

  let updated = original;
  let changed = false;
  let alreadyEnabled = false;

  if (featuresHeader.test(updated)) {
    if (codexHooksLine.test(updated)) {
      const match = updated.match(codexHooksLine);
      if (match && match[1] === 'true') {
        alreadyEnabled = true;
      } else {
        updated = updated.replace(codexHooksLine, 'codex_hooks = true');
        changed = true;
      }
    } else {
      // Insert codex_hooks = true immediately under the [features] header.
      updated = updated.replace(featuresHeader, (header) => `${header}\ncodex_hooks = true`);
      changed = true;
    }
  } else {
    const separator = updated.length > 0 && !updated.endsWith('\n') ? '\n\n' : updated.length > 0 ? '\n' : '';
    updated = `${updated}${separator}[features]\ncodex_hooks = true\n`;
    changed = true;
  }

  if (changed) {
    mkdirSync(CODEX_DIR, { recursive: true });
    writeFileSync(CODEX_CONFIG_PATH, updated);
  }

  return { changed, alreadyEnabled };
}

// ---------------------------------------------------------------------------
// AGENTS.md cleanup (legacy transcript-watcher artifact)
// ---------------------------------------------------------------------------

function stripClaudeMemContextBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const original = readFileSync(filePath, 'utf-8');
  const blockRegex = /\n?<claude-mem-context>[\s\S]*?<\/claude-mem-context>\n?/;
  if (!blockRegex.test(original)) return false;
  const stripped = original.replace(blockRegex, '').replace(/\s+$/, '\n');
  writeFileSync(filePath, stripped.trim() ? stripped : '');
  return true;
}

// ---------------------------------------------------------------------------
// Transcript-watch coexistence helper
// ---------------------------------------------------------------------------

const TRANSCRIPT_WATCH_PATH = path.join(homedir(), '.claude-mem', 'transcript-watch.json');

function readTranscriptWatchSnapshot(): { codexWatchPresent: boolean } {
  if (!existsSync(TRANSCRIPT_WATCH_PATH)) return { codexWatchPresent: false };
  try {
    const cfg = JSON.parse(readFileSync(TRANSCRIPT_WATCH_PATH, 'utf-8'));
    const present = Array.isArray(cfg?.watches) && cfg.watches.some((w: { name?: string }) => w?.name === 'codex');
    return { codexWatchPresent: present };
  } catch {
    return { codexWatchPresent: false };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function installCodexHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem native Codex hooks...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }
  const bunPath = findBunPath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service:    ${workerServicePath}`);

  try {
    const existing = readHooksJson();
    const merged = mergeClaudeMemHooks(existing, bunPath, workerServicePath);
    writeHooksJson(merged);
    console.log(`  Merged hooks into  ${CODEX_HOOKS_PATH}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }

  const flagResult = ensureCodexHooksFeatureFlag();
  if (flagResult.alreadyEnabled) {
    console.log(`  codex_hooks feature flag: already enabled in ${CODEX_CONFIG_PATH}`);
  } else if (flagResult.changed) {
    console.log(`  codex_hooks feature flag: enabled in ${CODEX_CONFIG_PATH}`);
  }

  if (stripClaudeMemContextBlock(CODEX_AGENTS_MD_PATH)) {
    console.log(`  Removed legacy <claude-mem-context> block from ${CODEX_AGENTS_MD_PATH}`);
  }

  // Issue #2249: native hooks supersede the transcript watcher. Remove the
  // codex watch entry so the legacy path doesn't keep writing AGENTS.md.
  try {
    const { uninstallCodexCli } = await import('./CodexCliInstaller.js');
    const beforeWatch = readTranscriptWatchSnapshot();
    uninstallCodexCli();
    const afterWatch = readTranscriptWatchSnapshot();
    if (beforeWatch.codexWatchPresent && !afterWatch.codexWatchPresent) {
      console.log('  Removed legacy Codex transcript watcher (superseded by hooks).');
    }
  } catch {
    // Best-effort cleanup — a missing transcript-watch.json is fine.
  }

  console.log(`
Registered ${Object.keys(CODEX_EVENT_TO_INTERNAL_EVENT).length} Codex hook events:`);
  for (const [codexEvent, mapping] of Object.entries(CODEX_EVENT_TO_INTERNAL_EVENT)) {
    console.log(`    ${codexEvent.padEnd(18)} → ${mapping.event}`);
  }

  console.log(`
Installation complete!

Hooks file:        ${CODEX_HOOKS_PATH}
Feature flag:      ${CODEX_CONFIG_PATH}  ([features] codex_hooks = true)
Pipeline:          worker-service.cjs hook codex <event>

Next steps:
  1. Make sure the worker is running:  npx claude-mem start
  2. Restart Codex CLI to load the hooks.
  3. Memory capture and context injection are automatic — no AGENTS.md writes.

Notes:
  - Native hooks supersede the legacy transcript watcher; the watcher entry
    has been removed to avoid dual-capture and AGENTS.md pollution (#2249).
  - Re-running this command is idempotent and only modifies entries marked
    with '${CLAUDE_MEM_MARKER}'. User-defined hooks are preserved.
`);

  return 0;
}

export function uninstallCodexHooks(): number {
  console.log('\nUninstalling Claude-Mem native Codex hooks...\n');

  if (!existsSync(CODEX_HOOKS_PATH)) {
    console.log(`  No hooks file at ${CODEX_HOOKS_PATH} — nothing to uninstall.`);
    return 0;
  }

  let file: CodexHooksFile;
  try {
    file = readHooksJson();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read ${CODEX_HOOKS_PATH}: ${message}`);
    return 1;
  }

  if (!file.hooks) {
    console.log('  No hook entries — nothing to uninstall.');
    return 0;
  }

  let removed = 0;
  for (const [eventName, groups] of Object.entries(file.hooks)) {
    const before = groups.reduce((n, g) => n + (g.hooks?.length ?? 0), 0);
    const pruned = pruneClaudeMemEntries(groups);
    const after = pruned.reduce((n, g) => n + (g.hooks?.length ?? 0), 0);
    removed += before - after;
    if (pruned.length > 0) {
      file.hooks[eventName] = pruned;
    } else {
      delete file.hooks[eventName];
    }
  }

  if (Object.keys(file.hooks).length === 0) delete file.hooks;
  writeHooksJson(file);
  console.log(`  Removed ${removed} claude-mem hook entr${removed === 1 ? 'y' : 'ies'} from ${CODEX_HOOKS_PATH}`);

  console.log('\nUninstallation complete!');
  console.log('Note: the codex_hooks feature flag in config.toml is left intact');
  console.log('      since other tools may rely on it. Restart Codex to apply.\n');
  return 0;
}

export function checkCodexHooksStatus(): number {
  console.log('\nClaude-Mem Codex Hooks Status\n');

  if (!existsSync(CODEX_HOOKS_PATH)) {
    console.log(`Hooks file: not found (${CODEX_HOOKS_PATH})`);
    console.log('Run: claude-mem install --ide codex-cli\n');
    return 0;
  }

  let file: CodexHooksFile;
  try {
    file = readHooksJson();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Hooks file: corrupt — ${message}\n`);
    return 0;
  }

  const installed: string[] = [];
  for (const [eventName, groups] of Object.entries(file.hooks ?? {})) {
    const has = groups.some(g => g.hooks?.some(isClaudeMemHookEntry));
    if (has) installed.push(eventName);
  }

  if (installed.length === 0) {
    console.log('Hooks file: present, but no claude-mem entries.');
    console.log('Run: claude-mem install --ide codex-cli\n');
    return 0;
  }

  console.log(`Hooks file: ${CODEX_HOOKS_PATH}`);
  console.log(`Pipeline:   worker-service.cjs hook codex <event>`);
  console.log(`Events:     ${installed.length}/${Object.keys(CODEX_EVENT_TO_INTERNAL_EVENT).length}`);
  for (const eventName of installed) {
    const internal = CODEX_EVENT_TO_INTERNAL_EVENT[eventName]?.event ?? '?';
    console.log(`  ${eventName.padEnd(18)} → ${internal}`);
  }

  if (existsSync(CODEX_CONFIG_PATH)) {
    const cfg = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
    const enabled = /codex_hooks\s*=\s*true/.test(cfg);
    console.log(`Feature flag: codex_hooks = ${enabled ? 'true' : 'NOT enabled — run install to fix'}`);
  } else {
    console.log('Feature flag: config.toml missing — run install to fix');
  }

  console.log('');
  return 0;
}

export async function handleCodexCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':   return installCodexHooks();
    case 'uninstall': return uninstallCodexHooks();
    case 'status':    return checkCodexHooksStatus();
    default:
      console.log(`
Claude-Mem Codex CLI Hooks Integration

Usage: claude-mem codex <command>

Commands:
  install       Install hooks into ~/.codex/hooks.json (and enable codex_hooks feature flag)
  uninstall     Remove claude-mem hooks (preserves user-defined hooks)
  status        Show installation status
`);
      return 0;
  }
}
