import { describe, it, expect } from 'vitest'
import { aiStreamRequestSchema } from '../src/shared/desktop-api'

/**
 * Regression for bug3/bug4: ai:stream ZodError when agent-core sends back an
 * assistant message whose toolCalls carry `inputError` (set by the agent loop
 * when the model emits invalid tool-input JSON) or `truncated` (set when the
 * token limit cuts off arguments). Both fields exist on AgentToolCall
 * (packages/agent-core/src/types.ts) but were missing from the sheets schema,
 * so `.strict()` rejected them and the whole ai:stream request failed.
 *
 * Trigger surfaced after switching provider to deepseek: deepseek returns
 * tool_calls, and a JSON parse failure produces inputError -> ZodError.
 */
describe('aiStreamRequestSchema - toolCall inputError/truncated (bug3/4)', () => {
  const baseRequest = {
    requestId: 'req-1',
    settings: {
      provider: 'deepseek',
      providers: {
        deepseek: { apiKey: 'sk-test', model: 'deepseek-v4-flash' },
      },
    },
    system: 'You are helpful',
    messages: [],
  }

  it('accepts assistant toolCalls carrying inputError (the bug)', () => {
    const req = {
      ...baseRequest,
      messages: [
        { role: 'user', text: 'hi' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call-1', name: 'tool-x', input: {}, inputError: 'invalid json' }],
        },
      ],
    }
    expect(() => aiStreamRequestSchema.parse(req)).not.toThrow()
  })

  it('accepts assistant toolCalls carrying truncated', () => {
    const req = {
      ...baseRequest,
      messages: [
        { role: 'user', text: 'hi' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call-1', name: 'tool-x', input: {}, truncated: true }],
        },
      ],
    }
    expect(() => aiStreamRequestSchema.parse(req)).not.toThrow()
  })

  it('still rejects genuinely unknown fields on toolCall (strict stays strict)', () => {
    const req = {
      ...baseRequest,
      messages: [
        { role: 'user', text: 'hi' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call-1', name: 'tool-x', input: {}, bogusField: 'x' }],
        },
      ],
    }
    expect(() => aiStreamRequestSchema.parse(req)).toThrow()
  })

  it('accepts normal messages without inputError/truncated', () => {
    const req = {
      ...baseRequest,
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello' },
      ],
    }
    expect(() => aiStreamRequestSchema.parse(req)).not.toThrow()
  })
})
