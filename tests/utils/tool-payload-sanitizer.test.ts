/**
 * Tool Payload Sanitizer Tests
 *
 * Verifies that tool_input/tool_response are stripped of bulk fields and
 * base64 image bytes before being sent to the observer LLM.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildSanitizerSettings,
  sanitizeToolInput,
  sanitizeToolResponse,
} from '../../src/utils/tool-payload-sanitizer.js';
import type { SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';

function makeSettings(overrides: Partial<SettingsDefaults> = {}): ReturnType<typeof buildSanitizerSettings> {
  const settings: SettingsDefaults = {
    CLAUDE_MEM_TRUNCATE_INPUT_TOOLS: 'Edit,Write,MultiEdit,NotebookEdit',
    CLAUDE_MEM_DROP_RESPONSE_TOOLS: 'Read,Write,Edit,NotebookEdit,Glob,LS,WebFetch',
    CLAUDE_MEM_TOOL_PAYLOAD_MAX_BYTES: '512',
    ...overrides,
  } as SettingsDefaults;
  return buildSanitizerSettings(settings);
}

describe('sanitizeToolInput', () => {
  it('replaces Edit old_string and new_string with size metadata', () => {
    const result = sanitizeToolInput('Edit', {
      file_path: '/x/y.ts',
      old_string: 'A'.repeat(5000),
      new_string: 'B'.repeat(5000),
    }, makeSettings()) as any;

    expect(result.file_path).toBe('/x/y.ts');
    expect(result.old_string).toEqual({ length: 5000, _omitted: true });
    expect(result.new_string).toEqual({ length: 5000, _omitted: true });
  });

  it('replaces Write content with size metadata', () => {
    const result = sanitizeToolInput('Write', {
      file_path: '/a.ts',
      content: 'Z'.repeat(50000),
    }, makeSettings()) as any;

    expect(result.file_path).toBe('/a.ts');
    expect(result.content).toEqual({ length: 50000, _omitted: true });
  });

  it('replaces MultiEdit edits array with count metadata', () => {
    const result = sanitizeToolInput('MultiEdit', {
      file_path: '/b.ts',
      edits: [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }, { old: 'e', new: 'f' }],
    }, makeSettings()) as any;

    expect(result.file_path).toBe('/b.ts');
    expect(result.edits).toEqual({ count: 3, _omitted: true });
  });

  it('preserves Bash command verbatim (not in truncate list)', () => {
    const input = { command: 'kubectl apply -f x.yaml', timeout: 30000 };
    const result = sanitizeToolInput('Bash', input, makeSettings());
    expect(result).toEqual(input);
  });

  it('caps oversized non-truncated input at maxBytes', () => {
    const result = sanitizeToolInput('Bash', {
      command: 'echo ' + 'A'.repeat(2000),
    }, makeSettings()) as any;

    expect(result._truncated).toBe(true);
    expect(result.originalBytes).toBeGreaterThan(2000);
    expect(typeof result.preview).toBe('string');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(700);
  });
});

describe('sanitizeToolResponse', () => {
  it('drops response entirely for tools in DROP_RESPONSE_TOOLS', () => {
    const result = sanitizeToolResponse('Read', {
      type: 'image',
      file: { base64: 'X'.repeat(800000), type: 'image/png', originalSize: 710077 },
    }, makeSettings());

    expect(result).toEqual({ _omitted: true, reason: 'dropped_by_policy' });
  });

  it('strips base64 image bytes from kept-tool responses', () => {
    const result = sanitizeToolResponse('Bash', {
      stdout: 'Done',
      stderr: '',
      content: [{
        type: 'image',
        file: { base64: 'Y'.repeat(800000), type: 'image/png', originalSize: 100 },
      }],
    }, makeSettings()) as any;

    expect(result.stdout).toBe('Done');
    expect(result.content[0]).toEqual({
      type: 'image',
      mediaType: 'image/png',
      originalSize: 100,
      _omitted: true,
    });
  });

  it('strips API-style image source blocks', () => {
    const result = sanitizeToolResponse('Bash', {
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'Q'.repeat(50000) },
      }],
    }, makeSettings()) as any;

    expect(result.content[0]).toEqual({
      type: 'image',
      mediaType: 'image/jpeg',
      _omitted: true,
    });
  });

  it('caps oversized kept-tool responses at maxBytes', () => {
    const result = sanitizeToolResponse('Bash', {
      stdout: 'L'.repeat(5000),
      stderr: '',
    }, makeSettings()) as any;

    expect(result._truncated).toBe(true);
    expect(result.originalBytes).toBeGreaterThan(5000);
    expect(typeof result.preview).toBe('string');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(700);
  });

  it('passes through small kept-tool responses unchanged', () => {
    const input = { stdout: 'ok\n', stderr: '', interrupted: false };
    const result = sanitizeToolResponse('Bash', input, makeSettings());
    expect(result).toEqual(input);
  });

  it('honors custom maxBytes setting', () => {
    const tight = makeSettings({ CLAUDE_MEM_TOOL_PAYLOAD_MAX_BYTES: '64' } as any);
    const result = sanitizeToolResponse('Bash', {
      stdout: 'L'.repeat(200),
    }, tight) as any;
    expect(result._truncated).toBe(true);
  });

  it('honors custom drop list', () => {
    const noDrops = makeSettings({ CLAUDE_MEM_DROP_RESPONSE_TOOLS: '' } as any);
    const result = sanitizeToolResponse('Read', { ok: true }, noDrops);
    expect(result).toEqual({ ok: true });
  });
});
