import readline from "readline/promises";
import { createAgent, SystemMessage, tool, Document } from "langchain";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import embeddingsModel from "../models/embeddings";
import { MemorySaver } from "@langchain/langgraph";
import chatModel from "../models/chat";

const checkpointer = new MemorySaver();

const vectorStore = new Chroma(embeddingsModel, {
  collectionName: "a-test-collection",
});

const retrieve = tool(
  async ({ query }) => {
    console.log("Retrieving docs for query:", query);
    const chunks = await vectorStore.similaritySearch(query);

    const roleIds = Array.from(
      new Set(chunks.map((doc) => doc.metadata.role_id))
    );
    console.log(`Retrieved ${roleIds.join(", ")} documents.`);

    const retriever = vectorStore.asRetriever({
      filter: { role_id: { $in: roleIds } },
      k: 50,
    });

    const retrievedDocs: Document[] = await retriever.invoke(query);

    // Group by role_id, then sort each group's chunks by chunk_id so the output is
    // deterministic and grouped by document.
    const groups = new Map<string, Document[]>();
    for (const doc of retrievedDocs) {
      const id = String(doc.metadata.role_id ?? "unknown");
      const arr = groups.get(id) ?? [];
      arr.push(doc);
      groups.set(id, arr);
    }

    // Sort doc ids to make group order deterministic
    const sortedDocIds = Array.from(groups.keys()).sort();

    const response = [];
    for (const docId of sortedDocIds) {
      const docs = groups.get(docId)!;
      const sorted = docs.sort((a, b) => {
        const aChunk = a.metadata.chunk_id;
        const bChunk = b.metadata.chunk_id;
        const aChunkNum = Number(aChunk);
        const bChunkNum = Number(bChunk);
        if (!Number.isNaN(aChunkNum) && !Number.isNaN(bChunkNum)) {
          return aChunkNum - bChunkNum;
        }
        if (aChunk < bChunk) return -1;
        if (aChunk > bChunk) return 1;
        return 0;
      });

      console.log(sorted);
      const header = `DOC ID: ${docId}\nContent: `;
      const body = sorted.map((d) => `${d.pageContent}`).join(" ");

      response.push(`${header}${body}`);
    }

    console.log("----");
    console.log(response);
    console.log("----");

    return [response.join("\n---\n")];
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

const systemPrompt = new SystemMessage(
  [
    "You have access to a tool that retrieves context from a jobs board for software engineers. Your job is to find the best jobs for the user and answer any questions they have about the jobs. ",
    "Use the tool to help answer user queries. Be concise, helpful and always reply back weather you have found the information or not, with suggestions for the user to find the information themselves if you don't have it.",
    "Before answering the user's query, make sure that you all relative information in the context.",
  ].join(" ")
);

const agent = createAgent({
  model: chatModel,
  tools: [retrieve],
  systemPrompt,
  checkpointer,
});

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "OHAI> ",
  });

  rl.prompt();

  for await (const line of rl) {
    let agentInputs = { messages: [{ role: "user", content: line }] };
    if (line.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
    } else {
      const response = await agent.invoke(agentInputs, {
        configurable: { thread_id: "1" },
      });
      console.log(
        response.messages[response.messages.length - 1].content as string
      );

      rl.prompt();
    }
  }
}

main().catch(console.error);
