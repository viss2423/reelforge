/**
 * The trend engine's view of a local LLM. The server's LLM module (src/ai/llm) implements
 * this interface; the trend engine only ever sees the port, so it still runs (ranking only)
 * when no model is installed, and is tested with a fake.
 */
export interface LlmPort {
  available(): Promise<boolean>
  complete(req: {
    system?: string
    prompt: string
    schema?: object
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }): Promise<{ text: string; json?: unknown; tokensPerSecond: number }>
}

/** Port used until a real LLM is wired in: never available. */
export const noLlm: LlmPort = {
  available: () => Promise.resolve(false),
  complete: () => Promise.reject(new Error('no local LLM is installed')),
}
