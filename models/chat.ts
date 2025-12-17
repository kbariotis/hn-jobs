import { ChatOllama } from "@langchain/ollama";

const model = new ChatOllama({
  model: "qwen3:1.7b",
  temperature: 0,
  maxRetries: 2,
});

export default model;
