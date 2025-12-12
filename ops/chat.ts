import { createAgent, SystemMessage, tool } from "langchain";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import embeddingsModel from "../models/embeddings";
import chatModel from "../models/chat";

const vectorStore = new Chroma(embeddingsModel, {
  collectionName: "a-test-collection",
});

async function main() {
  console.log("Loading docs");

  const retrieve = tool(
    async ({ query }) => {
      const retrievedDocs = await vectorStore.similaritySearch(query);
      const serialized = retrievedDocs
        .map((doc) => `ID: ${doc.metadata.doc_id}\nContent: ${doc.pageContent}`)
        .join("\n");
      return [serialized, retrievedDocs];
    },
    {
      name: "retrieve",
      description: "Retrieve information related to a query.",
      schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      responseFormat: "content_and_artifact",
    }
  );

  const tools = [retrieve];
  const systemPrompt = new SystemMessage(
    [
      "You have access to a tool that retrieves context from a jobs board for software engineers. Your job is to find the best jobs for the user and answer any questions they have about the jobs. ",
      "Use the tool to help answer user queries. Be concise, helpful and always reply back weather you have found the information or not, with suggestions for the user to find the information themselves if you don't have it.",
      "Before answering the user's query, make sure that you all relative information in the context.",
    ].join(" ")
  );

  const agent = createAgent({ model: chatModel, tools, systemPrompt });

  let inputMessage = `List all open roles for software engineers that accept remote candidates and use Node.js as a primary technology. Include their unique IDs as well.`;

  let agentInputs = { messages: [{ role: "user", content: inputMessage }] };

  const stream = await agent.stream(agentInputs, {
    streamMode: "updates",
  });
  for await (const chunk of stream) {
    const [step, content] = Object.entries(chunk)[0];
    console.log(`step: ${step}`);
    console.log(`content: ${JSON.stringify(content, null, 2)}`);
    console.log("-----\n");
  }
}

main().catch(console.error);
