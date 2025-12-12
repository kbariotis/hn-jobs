import { OllamaEmbeddings } from "@langchain/ollama";

const embeddings = new OllamaEmbeddings({ model: "qwen3-embedding:0.6b" });

export default embeddings;
