import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";

const model = new ChatOllama({
  // model: "llama3.2",
  model: "qwen3:1.7b",
  temperature: 0,
  maxRetries: 2,
});

export default model;
