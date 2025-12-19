require("dotenv").config();

import readline from "readline/promises";
import {
  createAgent,
  SystemMessage,
  tool,
  Document,
  HumanMessage,
} from "langchain";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import embeddingsModel from "../models/embeddings";
import { MemorySaver } from "@langchain/langgraph";
import chatModel from "../models/chat";

const checkpointer = new MemorySaver();

const vectorStore = new Chroma(embeddingsModel, {
  collectionName: process.env.CHROMA_COLLECTION_NAME,
});

function groupChunksToContext(chunks: Document[]) {
  // Group by role_id
  const groups = new Map<string, Document[]>();
  for (const doc of chunks) {
    const id = String(doc.metadata.role_id ?? "unknown");
    const arr = groups.get(id) ?? [];
    arr.push(doc);
    groups.set(id, arr);
  }

  // Sort doc ids to make group order deterministic
  const sortedDocIds = Array.from(groups.keys()).sort();

  const response: string[] = [];
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

    const header = `DOC ID: ${docId}\nContent: `;
    const body = sorted.map((d) => `${d.pageContent}`).join(" ");

    response.push(`${header}${body}`);
  }
  return response;
}

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

    return groupChunksToContext(retrievedDocs).join("\n---\n");
  },
  {
    name: "retrieve",
    description: "Retrieve jobs matching the users' query.",
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
    "You're a recruiter assistant bot (CRITICAL: You're only that and nothing else) that helps users with their job search. Your expertise is on tech related roles and your main source of related open roles is the monthly Hacker News Who is Hiring thread. You have access to a tool that retrieves context for you based on the user's query but in order for it to work best you need to get as much information from the user as possible about what they are looking for.",
    "Always interpret the user’s intent and, if the question is outside job-related topics (jobs, hiring, roles, applications, companies, career advice), you should answer in a way that relates it back to jobs. For example, ask how their question connects to work or careers, or provide job-related insight. Do not engage fully in unrelated topics.",
    "Be concise, helpful and always reply back weather you have found the information or not, with suggestions for the user to find the information themselves if you don't have it.",
    "Before answering the user's query, make sure that you have all relative information in the context.",
    "CRITICAL: DO NOT HALLUCINATE INFORMATION THAT DO NOT EXIST IN THE CONTEXT. IF YOU CANNOT FIND THE INFORMATION, SAY YOU CANNOT FIND IT RATHER THAN MAKING IT UP.",
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
    prompt: "Assistant> ",
  });

  rl.prompt();

  for await (const line of rl) {
    if (line.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
    } else if (line.trim() === "") {
      rl.prompt();
    } else {
      const response = await agent.invoke(
        {
          messages: [new HumanMessage(line)],
        },
        {
          configurable: { thread_id: new Date().getTime() },
        }
      );
      console.log(
        response.messages[response.messages.length - 1].content as string
      );

      rl.prompt();
    }
  }
}

main().catch(console.error);
