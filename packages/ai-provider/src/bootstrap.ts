import type { AiSettings, LegacyAiSettings } from './types'
import { resolveAiSettings } from './providers'

/** Default model written into ai-settings.json when no model is resolved from env/config. */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

export interface DeepseekCredentials {
  apiKey: string
  model: string
}

/**
 * Pure credential resolver. Precedence: env -> configObj -> defaults. Does no
 * file I/O; the caller passes a subset of `process.env` and the parsed
 * `env_config.json` object.
 *
 * TODO(design-gap): technical-design §4 Task C typed the params as
 * `{ KEY?: string }`, but the sheets app workspace enables
 * `exactOptionalPropertyTypes`, under which `{ KEY: string | undefined }` (the
 * shape produced by forwarding `process.env.X`) is not assignable to
 * `{ KEY?: string }`. The params therefore explicitly allow `string | undefined`
 * so callers can forward `process.env` values verbatim. Behavior is unchanged:
 * `??` treats `undefined` and a missing key identically.
 */
export function resolveDeepseekCredentials(
  env: { DEEPSEEK_API_KEY?: string | undefined; DEEPSEEK_MODEL?: string | undefined },
  configObj: { DEEPSEEK_API_KEY?: string | undefined; DEEPSEEK_MODEL?: string | undefined },
): DeepseekCredentials {
  return {
    apiKey: env.DEEPSEEK_API_KEY ?? configObj.DEEPSEEK_API_KEY ?? '',
    model: env.DEEPSEEK_MODEL ?? configObj.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL,
  }
}

/**
 * Pure bootstrap/migration decision for ai-settings.json. Does no file I/O.
 *
 * Returns `writeBack` (non-null when the caller should persist the resolved
 * settings to disk) and `settings` (what the caller should return to the
 * renderer). In the seed/migrate branches `writeBack` and `settings` are the
 * same already-resolved + force-deepseek object, so the caller persists exactly
 * what it returns.
 *
 * Branches:
 * 1. `stored` has no `providers` field (file missing or pre-provider legacy
 *    shape) -> resolve defaults and force deepseek (seed).
 * 2. `stored.provider === 'genspark'` (legacy hardlock residue) -> resolve
 *    stored over defaults, force deepseek, keep other provider slots (migrate).
 * 3. otherwise (incl. already deepseek) -> respect the existing config, no
 *    writeBack.
 */
export function ensureDeepseekSettings(
  stored: (Partial<AiSettings> & LegacyAiSettings) | Record<string, never>,
  defaults: AiSettings,
  creds: DeepseekCredentials,
): { writeBack: AiSettings | null; settings: AiSettings } {
  // TODO(design-gap): technical-design §4 Task C assumes `resolveAiSettings`
  // returns a fresh object and never mutates `defaults`, but providers.ts
  // mutates `defaults.providers.custom` and returns `defaults` itself in the
  // `!stored.providers` branch (providers.ts:120-128). Clone `defaults` so the
  // caller's object is never polluted regardless of which branch runs.
  const defaultsClone: AiSettings = {
    provider: defaults.provider,
    providers: { ...defaults.providers },
  }

  const forceDeepseek = (s: AiSettings): AiSettings => {
    s.provider = 'deepseek'
    s.providers.deepseek = { apiKey: creds.apiKey, model: creds.model }
    return s
  }

  if (!stored.providers) {
    const resolved = resolveAiSettings(stored, defaultsClone)
    return { writeBack: forceDeepseek(resolved), settings: resolved }
  }

  if (stored.provider === 'genspark') {
    const resolved = resolveAiSettings(stored, defaultsClone)
    return { writeBack: forceDeepseek(resolved), settings: resolved }
  }

  return { writeBack: null, settings: resolveAiSettings(stored, defaultsClone) }
}
