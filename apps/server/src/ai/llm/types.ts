/**
 * The local language-model port. Everything that wants text from the LLM (highlights,
 * copywriter, caption emphasis, other modules) goes through this interface, so tests can
 * fake it and the runtime (llama.cpp server today) can change without touching callers.
 */

export interface LlmRequest {
  system?: string
  prompt: string
  /** JSON Schema: decoding is grammar-constrained so the output always parses. */
  schema?: object
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface LlmResult {
  text: string
  /** Parsed output when `schema` was given. */
  json?: unknown
  /** Generation speed of this request. */
  tokensPerSecond: number
  /** Prompt-processing speed of this request (tokens/s). */
  promptTokensPerSecond?: number
  promptTokens?: number
  completionTokens?: number
  /** Wall time including any model load. */
  ms?: number
}

export interface LlmInfo {
  /** Model file name (e.g. `Qwen3.5-4B-Q4_K_M.gguf`). */
  model: string
  /** `vulkan`, `cpu`, … */
  backend: string
  loaded: boolean
}

export interface LlmPort {
  /** True when the runtime and a model are installed (does not load the model). */
  available(): Promise<boolean>
  complete(req: LlmRequest): Promise<LlmResult>
  /** Installed model/runtime, if any. */
  info?(): Promise<LlmInfo | undefined>
  /** Frees the model now (e.g. before another large model runs). */
  unload?(): Promise<void>
}

/** Thrown when no runtime or model is installed; callers turn it into a clear UI message. */
export class LlmUnavailableError extends Error {
  constructor(
    message = 'The local AI model is not installed — run `pnpm bootstrap` on the host computer',
  ) {
    super(message)
    this.name = 'LlmUnavailableError'
  }
}
