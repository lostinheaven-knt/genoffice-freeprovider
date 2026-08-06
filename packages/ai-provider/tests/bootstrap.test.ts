import { describe, expect, it } from 'vitest'
import { ensureDeepseekSettings, resolveDeepseekCredentials } from '../src/bootstrap'
import { defaultAiSettings } from '../src/providers'

describe('resolveDeepseekCredentials', () => {
  it('prefers env vars over the config object', () => {
    const c = resolveDeepseekCredentials(
      { DEEPSEEK_API_KEY: 'env-key', DEEPSEEK_MODEL: 'env-model' },
      { DEEPSEEK_API_KEY: 'cfg-key', DEEPSEEK_MODEL: 'cfg-model' },
    )
    expect(c).toEqual({ apiKey: 'env-key', model: 'env-model' })
  })

  it('falls back to the config object when env vars are missing', () => {
    const c = resolveDeepseekCredentials(
      {},
      { DEEPSEEK_API_KEY: 'cfg-key', DEEPSEEK_MODEL: 'cfg-model' },
    )
    expect(c).toEqual({ apiKey: 'cfg-key', model: 'cfg-model' })
  })

  it('uses empty key and the deepseek-v4-flash constant when both sources are empty', () => {
    const c = resolveDeepseekCredentials({}, {})
    expect(c).toEqual({ apiKey: '', model: 'deepseek-v4-flash' })
  })
})

describe('ensureDeepseekSettings', () => {
  const creds = { apiKey: 'sk-test', model: 'deepseek-v4-flash' }

  it('seeds deepseek defaults when the settings file is missing (stored={})', () => {
    const { writeBack, settings } = ensureDeepseekSettings({}, defaultAiSettings(), creds)
    expect(settings.provider).toBe('deepseek')
    expect(settings.providers.deepseek).toEqual({ apiKey: 'sk-test', model: 'deepseek-v4-flash' })
    expect(writeBack).not.toBeNull()
    // writeBack and settings are the same resolved object so the caller persists what it returns
    expect(writeBack).toBe(settings)
  })

  it('migrates a legacy genspark-hardlock file to deepseek while keeping other provider slots', () => {
    const stored = {
      provider: 'genspark',
      providers: {
        genspark: { apiKey: '', model: 'claude-opus-4-7' },
        anthropic: { apiKey: 'sk-ant', model: 'claude-opus-4-7' },
      },
    } as any
    const { writeBack, settings } = ensureDeepseekSettings(stored, defaultAiSettings(), creds)
    expect(settings.provider).toBe('deepseek')
    expect(settings.providers.deepseek).toEqual({ apiKey: 'sk-test', model: 'deepseek-v4-flash' })
    // anthropic slot comes from stored and is preserved
    expect(settings.providers.anthropic.apiKey).toBe('sk-ant')
    expect(writeBack).not.toBeNull()
    expect(writeBack).toBe(settings)
  })

  it('leaves an already-deepseek file untouched (no writeBack)', () => {
    const stored = {
      provider: 'deepseek',
      providers: {
        deepseek: { apiKey: 'sk-existing', model: 'deepseek-v4-flash' },
      },
    } as any
    const { writeBack, settings } = ensureDeepseekSettings(stored, defaultAiSettings(), creds)
    expect(settings.provider).toBe('deepseek')
    // existing key is not overwritten by the resolved creds
    expect(settings.providers.deepseek.apiKey).toBe('sk-existing')
    expect(writeBack).toBeNull()
  })

  it('respects an existing non-genspark provider (no writeBack)', () => {
    const stored = {
      provider: 'openai',
      providers: {
        openai: { apiKey: 'sk-oai', model: 'gpt-4.1-mini' },
      },
    } as any
    const { writeBack, settings } = ensureDeepseekSettings(stored, defaultAiSettings(), creds)
    expect(settings.provider).toBe('openai')
    expect(writeBack).toBeNull()
  })

  it('does not mutate the caller-provided defaults object', () => {
    const defaults = defaultAiSettings()
    const defaultsSnapshot = {
      provider: defaults.provider,
      providers: { ...defaults.providers, deepseek: { ...defaults.providers.deepseek } },
    }
    ensureDeepseekSettings({}, defaults, creds)
    // defaults must be untouched even when stored has no providers (resolveAiSettings
    // otherwise mutates defaults.providers.custom in the legacy branch)
    expect(defaults.provider).toBe(defaultsSnapshot.provider)
    expect(defaults.providers.deepseek).toEqual(defaultsSnapshot.providers.deepseek)
    expect(defaults.providers.custom).toEqual(defaultsSnapshot.providers.custom)
  })
})
