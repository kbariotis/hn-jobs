import { initChatModel } from "langchain";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// "<provider>:<model>", e.g. "ollama:qwen3:8b", "google-genai:gemini-2.5-flash".
// The provider package must be installed (@langchain/ollama, @langchain/google-genai, ...).
export const DEFAULT_EXTRACT_MODEL = "google-genai:gemini-3.5-flash"; // chosen via eval:extract

export function extractModelId(): string {
  return process.env.EXTRACT_MODEL || DEFAULT_EXTRACT_MODEL;
}

const SETTINGS = { temperature: 0, maxRetries: 2 };

/**
 * Gemini (the production provider) is constructed from a static import: initChatModel loads
 * providers with a computed `import(pkg)`, which serverless bundlers can't trace, so on Vercel
 * the provider's entry point is missing and every call fails. Same model and settings
 * initChatModel would build. Other providers (e.g. Ollama, local only) still go through it.
 */
export async function getExtractModel(modelId = extractModelId()): Promise<BaseChatModel> {
  const i = modelId.indexOf(":");
  const [provider, model] = [modelId.slice(0, i), modelId.slice(i + 1)];
  if (provider === "google-genai") {
    return new ChatGoogleGenerativeAI({ model, ...SETTINGS });
  }
  return initChatModel(modelId, SETTINGS);
}
