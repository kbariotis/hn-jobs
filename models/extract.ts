import { initChatModel } from "langchain";

// "<provider>:<model>", e.g. "ollama:qwen3:8b", "google-genai:gemini-2.5-flash".
// The provider package must be installed (@langchain/ollama, @langchain/google-genai, ...).
export const DEFAULT_EXTRACT_MODEL = "ollama:mistral:7b";

export function extractModelId(): string {
  return process.env.EXTRACT_MODEL || DEFAULT_EXTRACT_MODEL;
}

export async function getExtractModel(modelId = extractModelId()) {
  return initChatModel(modelId, { temperature: 0, maxRetries: 2 });
}
