/**
 * Tests for Cursor `stop` hook -> summarize compatibility.
 *
 * Validates the three changes that make Cursor sessions actually get
 * summarized end-to-end (previously they were silently skipped):
 *   1. The cursor adapter derives `transcriptPath` from `cwd + conversation_id`,
 *      since Cursor does not pass a transcript path on stdin.
 *   2. `extractLastMessage` accepts both `{type:"assistant"}` (Claude Code)
 *      and `{role:"assistant"}` (Cursor) per-line role markers.
 *   3. `extractLastMessage` keeps scanning back through assistant turns when
 *      the most recent one is a pure tool_use (no text content), instead of
 *      returning an empty string and causing the summary to be skipped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { extractLastMessage } from '../src/shared/transcript-parser.js';
import { cursorAdapter } from '../src/cli/adapters/cursor.js';

// ---------------------------------------------------------------------------
// 1. Transcript parser: role-vs-type, and skipping empty-text turns
// ---------------------------------------------------------------------------

describe('extractLastMessage — Cursor JSONL compatibility', () => {
  const tmpDir = join(tmpdir(), `cursor-transcript-test-${Date.now()}`);
  const transcriptPath = join(tmpDir, 'transcript.jsonl');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads Cursor JSONL using {"role":"assistant"} (not just {"type":"assistant"})', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hi from cursor' }] } },
    ];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('hi from cursor');
  });

  it('skips a tool-only last assistant turn and returns the previous text-bearing one', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: 'q1' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'real answer' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: 'q2' }] } },
      // Tool-only assistant turn (most recent) — must NOT be returned.
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] } },
    ];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('real answer');
  });

  it('still returns "" when no assistant turn exists at all', () => {
    const lines = [{ role: 'user', message: { content: [{ type: 'text', text: 'lonely' }] } }];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('');
  });

  it('still works for Claude Code format using {"type":"assistant"}', () => {
    const lines = [
      { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'claude code answer' }] } },
    ];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('claude code answer');
  });
});

// ---------------------------------------------------------------------------
// 2. Cursor adapter: deriveCursorTranscriptPath
// ---------------------------------------------------------------------------

describe('cursorAdapter.normalizeInput — transcriptPath derivation', () => {
  // Build a fake Cursor projects layout under HOME and assert the adapter
  // discovers the right file.
  const sessionId = `c0ffee${Date.now()}`;
  const fakeCwd = join(tmpdir(), 'fake.workspace', 'subdir');
  const slug = fakeCwd.replace(/^\//, '').replace(/[/.]/g, '-');
  const transcriptDir = join(homedir(), '.cursor', 'projects', slug, 'agent-transcripts', sessionId);
  const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);

  beforeEach(() => {
    mkdirSync(fakeCwd, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n');
  });

  afterEach(() => {
    if (existsSync(transcriptPath)) rmSync(transcriptPath);
    if (existsSync(transcriptDir)) rmSync(transcriptDir, { recursive: true, force: true });
    if (existsSync(fakeCwd)) rmSync(fakeCwd, { recursive: true, force: true });
  });

  it('derives transcriptPath from cwd + conversation_id when the file exists', () => {
    const normalized = cursorAdapter.normalizeInput({
      cwd: fakeCwd,
      conversation_id: sessionId,
    });

    expect(normalized.sessionId).toBe(sessionId);
    expect(normalized.transcriptPath).toBe(transcriptPath);
  });

  it('returns transcriptPath: undefined when the file does not exist', () => {
    rmSync(transcriptPath);
    const normalized = cursorAdapter.normalizeInput({
      cwd: fakeCwd,
      conversation_id: sessionId,
    });

    expect(normalized.sessionId).toBe(sessionId);
    expect(normalized.transcriptPath).toBeUndefined();
  });

  it('returns transcriptPath: undefined when conversation_id is absent', () => {
    const normalized = cursorAdapter.normalizeInput({ cwd: fakeCwd });
    expect(normalized.transcriptPath).toBeUndefined();
  });
});
