import { ChatOllama } from "@langchain/ollama";

const model = new ChatOllama({
  model: "mistral:7b",
  temperature: 0,
  maxRetries: 2,
});

export default model;
