export type {
  AiChatRequest,
  AiChatResponse,
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  GenSparkAccountStatus,
  LegacyAiSettings,
} from './types'
export {
  AI_PROVIDERS,
  GENSPARK_LLM_BASE_URLS,
  KIMI_DEFAULT_BASE_URL,
  KIMI_DEFAULT_MODEL,
  defaultAiSettings,
  resolveAiSettings,
} from './providers'
export {
  DEEPSEEK_DEFAULT_MODEL,
  ensureDeepseekSettings,
  resolveDeepseekCredentials,
  resolveKimiCredentials,
} from './bootstrap'
export type { DeepseekCredentials, KimiCredentials } from './bootstrap'
export { chatForProvider } from './chat'
export { AiCreditsError, sseLines, streamForProvider } from './stream'
export type { StreamCallbacks } from './stream'
export {
  AI_CHAT_RESPONSE_TIMEOUT_MS,
  AI_CONNECT_TIMEOUT_MS,
  AI_IDLE_TIMEOUT_MS,
  AiTimeoutError,
  createStreamWatchdog,
} from './watchdog'
export type { StreamWatchdog } from './watchdog'
