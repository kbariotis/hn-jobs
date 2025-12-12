import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatOllama } from "@langchain/ollama";
import { createAgent } from "langchain";

const model = new ChatOllama({
  model: "qwen3:8b", // Default value
  temperature: 0,
  maxRetries: 2,
  // other params...
});

async function main() {
  const client = new MultiServerMCPClient({
    math: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@devabdultech/hn-mcp-server"],
    },
  });
  console.log("Getting tools");
  const tools = await client.getTools();
  console.log("Creating agent");
  const agent = createAgent({ model, tools });

  console.log("Invoking agent");
  const response = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          "This is the latest Who's Hiring thread on HackerNews, https://news.ycombinator.com/item?id=46108941. List all open roles for software engineers that accept remote candidates in Europe and use Node.js or React as a primary technology. One line per job",
      },
    ],
  });

  console.log("Response:", response);
}

main();
