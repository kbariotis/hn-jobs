import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { OllamaEmbeddings } from "@langchain/ollama";
import type { TaskType } from "@google/generative-ai";

// "<provider>:<model>". Stored next to each vector, so switching models never mixes spaces.
export const DEFAULT_EMBED_MODEL = "google-genai:gemini-embedding-001";

export const embedModelId = () => process.env.EMBED_MODEL || DEFAULT_EMBED_MODEL;

/**
 * Gemini embeds queries and documents differently (asymmetric retrieval).
 * Ollama ignores the side.
 */
export function getEmbeddings(
  side: "query" | "document",
  modelId = embedModelId(),
): EmbeddingsInterface {
  const i = modelId.indexOf(":");
  const [provider, model] = [modelId.slice(0, i), modelId.slice(i + 1)];
  if (provider === "google-genai") {
    const taskType = (side === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT") as TaskType;
    return new GoogleGenerativeAIEmbeddings({ model, taskType, maxRetries: 3 });
  }
  if (provider === "ollama") {
    return new OllamaEmbeddings({ model });
  }
  throw new Error(`Unsupported embedding provider in "${modelId}"`);
}
