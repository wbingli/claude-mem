/**
 * Tool Payload Sanitizer
 *
 * Strips bulk content from tool_input and tool_response before they are
 * embedded in observer prompts. The observer's job is to record what was
 * built/fixed/discovered — file diffs and screenshot bytes are noise that
 * compounds across the SDK conversation history.
 *
 * Three layers, applied in order:
 *   1. Per-tool input shaping — keep identifying fields, replace bulk fields
 *      with `{ length, _omitted: true }` metadata.
 *   2. Per-tool response policy — drop entirely for echo-style tools.
 *   3. Recursive image strip + final byte cap — applies to whatever survives.
 *
 * All policy is driven by settings so users can dial it up or down.
 */

import type { SettingsDefaults } from '../shared/SettingsDefaultsManager.js';

interface SanitizerSettings {
  truncateInputTools: Set<string>;
  dropResponseTools: Set<string>;
  maxBytes: number;
}

export function buildSanitizerSettings(settings: SettingsDefaults): SanitizerSettings {
  const parseList = (s: string | undefined): Set<string> =>
    new Set((s ?? '').split(',').map(t => t.trim()).filter(Boolean));
  const maxRaw = parseInt(settings.CLAUDE_MEM_TOOL_PAYLOAD_MAX_BYTES ?? '512', 10);
  return {
    truncateInputTools: parseList(settings.CLAUDE_MEM_TRUNCATE_INPUT_TOOLS),
    dropResponseTools: parseList(settings.CLAUDE_MEM_DROP_RESPONSE_TOOLS),
    maxBytes: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 512,
  };
}

const OMIT_MARKER = '_omitted' as const;

function omittedString(value: string): { length: number; [OMIT_MARKER]: true } {
  return { length: value.length, [OMIT_MARKER]: true };
}

function omittedArray(value: unknown[]): { count: number; [OMIT_MARKER]: true } {
  return { count: value.length, [OMIT_MARKER]: true };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively replace base64 image payloads with a metadata stub.
 * Matches Claude Code's image content shape: { type: "image", file: { base64, type, originalSize } }
 * and the simpler { type: "image", source: { data, media_type } } shape.
 */
function stripImages(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripImages);
  }
  if (!isPlainObject(value)) return value;

  const obj = value as Record<string, unknown>;

  // Claude Code Read result: { type: "image", file: { base64, type, originalSize } }
  if (obj.type === 'image' && isPlainObject(obj.file) && typeof (obj.file as any).base64 === 'string') {
    const file = obj.file as Record<string, unknown>;
    return {
      type: 'image',
      mediaType: file.type,
      originalSize: file.originalSize,
      [OMIT_MARKER]: true,
    };
  }
  // API-style image block: { type: "image", source: { data, media_type } }
  if (obj.type === 'image' && isPlainObject(obj.source) && typeof (obj.source as any).data === 'string') {
    const src = obj.source as Record<string, unknown>;
    return {
      type: 'image',
      mediaType: src.media_type,
      [OMIT_MARKER]: true,
    };
  }
  // Bare base64 field on any object — drop the bytes, keep size hint.
  if (typeof obj.base64 === 'string' && obj.base64.length > 256) {
    const { base64, ...rest } = obj;
    return { ...rest, base64: omittedString(base64) };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = stripImages(v);
  }
  return out;
}

/**
 * Tool-input shaper. Keeps identifying fields (file_path, etc.) and replaces
 * bulk content fields with metadata stubs.
 */
function shapeToolInput(toolName: string, input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const i = input;

  switch (toolName) {
    case 'Edit': {
      const out: Record<string, unknown> = { file_path: i.file_path };
      if (typeof i.old_string === 'string') out.old_string = omittedString(i.old_string);
      if (typeof i.new_string === 'string') out.new_string = omittedString(i.new_string);
      if (i.replace_all !== undefined) out.replace_all = i.replace_all;
      return out;
    }
    case 'Write': {
      const out: Record<string, unknown> = { file_path: i.file_path };
      if (typeof i.content === 'string') out.content = omittedString(i.content);
      return out;
    }
    case 'MultiEdit': {
      const out: Record<string, unknown> = { file_path: i.file_path };
      if (Array.isArray(i.edits)) out.edits = omittedArray(i.edits);
      return out;
    }
    case 'NotebookEdit': {
      const out: Record<string, unknown> = {
        notebook_path: i.notebook_path,
        cell_id: i.cell_id,
        cell_type: i.cell_type,
        edit_mode: i.edit_mode,
      };
      if (typeof i.new_source === 'string') out.new_source = omittedString(i.new_source);
      return out;
    }
    default:
      return input;
  }
}

/**
 * Final byte cap. If the JSON of `value` exceeds `maxBytes`, replace with a
 * truncation marker. Applied after image-strip and per-tool shaping.
 */
function capJson(value: unknown, maxBytes: number): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return value;
  // Truncate the stringified form so the observer still gets a preview.
  const buf = Buffer.from(json, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return {
    _truncated: true,
    originalBytes: buf.length,
    preview: buf.subarray(0, end).toString('utf8'),
  };
}

export function sanitizeToolInput(
  toolName: string,
  input: unknown,
  settings: SanitizerSettings,
): unknown {
  if (input === undefined || input === null) return input;
  let result: unknown = input;
  if (settings.truncateInputTools.has(toolName)) {
    result = shapeToolInput(toolName, result);
  }
  result = stripImages(result);
  result = capJson(result, settings.maxBytes);
  return result;
}

export function sanitizeToolResponse(
  toolName: string,
  response: unknown,
  settings: SanitizerSettings,
): unknown {
  if (response === undefined || response === null) return response;
  if (settings.dropResponseTools.has(toolName)) {
    return { _omitted: true, reason: 'dropped_by_policy' };
  }
  let result: unknown = stripImages(response);
  result = capJson(result, settings.maxBytes);
  return result;
}
