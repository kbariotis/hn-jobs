import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";

const model = new ChatOllama({
  model: "llama3.2",
  temperature: 0,
  maxRetries: 2,
});

export default model;
