import { describe, it, expect } from 'bun:test';
import { SAMPLE_CONFIG } from '../src/services/transcripts/config.js';

describe('Codex transcript session completion', () => {
  const codexSchema = SAMPLE_CONFIG.schemas?.codex;

  it('treats Codex task_complete as the session end event', () => {
    const sessionEnd = codexSchema?.events.find((event) => event.name === 'session-end');

    expect(sessionEnd?.action).toBe('session_end');
    expect(sessionEnd?.match?.path).toBe('payload.type');
    expect(sessionEnd?.match?.in).toContain('task_complete');
  });

  it('captures last_agent_message before queueing the summary', () => {
    const finalAssistantIndex = codexSchema?.events.findIndex((event) => event.name === 'final-assistant-message') ?? -1;
    const sessionEndIndex = codexSchema?.events.findIndex((event) => event.name === 'session-end') ?? -1;
    const finalAssistant = codexSchema?.events[finalAssistantIndex];

    expect(finalAssistant?.action).toBe('assistant_message');
    expect(finalAssistant?.match).toEqual({ path: 'payload.type', equals: 'task_complete' });
    expect(finalAssistant?.fields?.message).toBe('payload.last_agent_message');
    expect(finalAssistantIndex).toBeGreaterThan(-1);
    expect(sessionEndIndex).toBeGreaterThan(finalAssistantIndex);
  });
});
