import { describe, expect, it } from 'vitest'
import {
  ensureDeepseekSettings,
  resolveDeepseekCredentials,
  resolveKimiCredentials,
} from '../src/bootstrap'
import { KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL, defaultAiSettings } from '../src/providers'

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

describe('resolveKimiCredentials', () => {
  it('prefers env over configObj over defaults', () => {
    const c = resolveKimiCredentials(
      {
        KIMI_API_KEY: 'env-key',
        KIMI_MODEL: 'env-model',
        KIMI_BASE_URL: 'https://env.example.com',
      },
      {
        KIMI_API_KEY: 'cfg-key',
        KIMI_MODEL: 'cfg-model',
        KIMI_BASE_URL: 'https://cfg.example.com',
      },
    )
    expect(c).toEqual({ apiKey: 'env-key', model: 'env-model', baseUrl: 'https://env.example.com' })
    const d = resolveKimiCredentials({}, { KIMI_API_KEY: 'cfg-key' })
    expect(d).toEqual({
      apiKey: 'cfg-key',
      model: KIMI_DEFAULT_MODEL,
      baseUrl: KIMI_DEFAULT_BASE_URL,
    })
    const e = resolveKimiCredentials({}, {})
    expect(e).toEqual({ apiKey: '', model: KIMI_DEFAULT_MODEL, baseUrl: KIMI_DEFAULT_BASE_URL })
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

  it('migrates a legacy single-endpoint file (stored={apiKey, model, baseUrl}) to deepseek and seeds custom from the legacy endpoint', () => {
    const stored = {
      apiKey: 'legacy-key',
      model: 'legacy-model',
      baseUrl: 'https://legacy.example.com/v1',
    }
    const defaults = defaultAiSettings()
    const { writeBack, settings } = ensureDeepseekSettings(stored as any, defaults, creds)
    // seed branch forces deepseek with creds
    expect(settings.provider).toBe('deepseek')
    expect(settings.providers.deepseek).toEqual({ apiKey: 'sk-test', model: 'deepseek-v4-flash' })
    // legacy single-endpoint fields migrate into the custom slot (resolveAiSettings)
    expect(settings.providers.custom).toEqual({
      apiKey: 'legacy-key',
      model: 'legacy-model',
      baseUrl: 'https://legacy.example.com/v1',
    })
    expect(writeBack).not.toBeNull()
    expect(writeBack).toBe(settings)
    // defaults not polluted by resolveAiSettings' custom-migration mutate
    expect(defaults.providers.custom).toEqual({ apiKey: '', model: '', baseUrl: '' })
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
