import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";

import { Document, tool, createAgent, SystemMessage } from "langchain";
import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { z } from "zod";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const llm = new ChatOllama({
  model: "qwen3:8b", // Default value
  temperature: 0,
  maxRetries: 2,
  // other params...
});
const summaryLlm = new ChatOllama({
  model: "llama3.2", // Default value
  temperature: 0,
  maxRetries: 2,
  // other params...
});

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 100,
  chunkOverlap: 20,
});

const embeddings = new OllamaEmbeddings();
const vectorStore = new MemoryVectorStore(embeddings);

const loader = new CheerioWebBaseLoader(
  "https://news.ycombinator.com/item?id=46108941",
  {
    // selector: "table.comment-tree .commtext.c00",
  }
);

async function main() {
  console.log("Loading docs");
  const docs = await loader.scrape();

  console.log("Loaded docs");
  const summaryAgent = createAgent({ model: summaryLlm });

  for await (const chunk of docs("td.ind[indent=0]").toArray()) {
    const first = docs(chunk).next().next().find(".commtext.c00");
    const hnUserEl = docs(chunk).next().next().find(".hnuser");
    const ageEl = docs(chunk).next().next().find(".age");
    const commentId = first.closest(".athing.comtr").attr("id");

    console.log(first.text());
    const r = await summaryAgent.invoke({
      messages: [
        {
          role: "user",
          content: `You are a parser that converts Hacker News “Who’s Hiring” comments into structured job listings. Given the text of one comment, identify all distinct job roles described and return a JSON array.
          For each role, extract: company_name, role_title, employment_type, remote_policy, locations, tech_stack, seniority, salary_range, full_description, and source_links.
          If some field is not explicitly mentioned, use null instead of guessing. Response with a JSON array directly: ${first.text()}`,
        },
      ],
    });

    console.log(r.messages[1].content);
    const allSplits = await splitter.splitDocuments([
      new Document({
        pageContent: r.messages[1].content as string,
      }),
    ]);

    console.log(allSplits);

    break;
    await vectorStore.addDocuments(allSplits);
  }

  console.log("Vector loaded");

  // const retrieve = tool(
  //   async ({ query }) => {
  //     const retrievedDocs = await vectorStore.similaritySearch(query);
  //     const serialized = retrievedDocs
  //       .map(
  //         (doc) => `Source: ${doc.metadata.source}\nContent: ${doc.pageContent}`
  //       )
  //       .join("\n");
  //     return [serialized, retrievedDocs];
  //   },
  //   {
  //     name: "retrieve",
  //     description: "Retrieve information related to a query.",
  //     schema: {
  //       type: "object",
  //       properties: { query: { type: "string" } },
  //       required: ["query"],
  //       additionalProperties: false,
  //     },
  //     responseFormat: "content_and_artifact",
  //   }
  // );

  // const tools = [retrieve];
  // const systemPrompt = new SystemMessage(
  //   [
  //     "You have access to a tool that retrieves context from a jobs board for software engineers. Your job is to find the best jobs for the user and answer any questions they have about the jobs. ",
  //     "Use the tool to help answer user queries. Be concise, helpful and always reply back weather you have found the information or not, with suggestions for the user to find the information themselves if you don't have it.",
  //     "Before answering the user's query, make sure that you all relative information in the context.",
  //   ].join(" ")
  // );

  // const agent = createAgent({ model: llm, tools, systemPrompt });

  // let inputMessage = `List all open roles for software engineers that accept remote candidates in Europe and use Node.js or React as a primary technology. One line per job.`;

  // let agentInputs = { messages: [{ role: "user", content: inputMessage }] };

  // const stream = await agent.stream(agentInputs, {
  //   streamMode: "updates",
  // });
  // for await (const chunk of stream) {
  //   const [step, content] = Object.entries(chunk)[0];
  //   console.log(`step: ${step}`);
  //   console.log(`content: ${JSON.stringify(content, null, 2)}`);
  //   console.log("-----\n");
  // }
}

main().catch(console.error);
