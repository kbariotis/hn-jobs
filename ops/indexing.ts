require("dotenv").config();

import { createAgent, Document, HumanMessage } from "langchain";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import embeddingsModel from "../models/embeddings";
import chatModel from "../models/chat";
import extractPrompt from "../prompts/extract";

const DATA_URL =
  process.env.DATA_URL || "http://hn.algolia.com/api/v1/items/46108941";

type Entry = {
  company_name: string | null;
  role_title: string | null;
  employment_type: string | null;
  remote_policy: string | null;
  locations: string[];
  tech_stack: string[];
  seniority: string | null;
  salary_range: string | null;
  description: string | null;
  apply_url: string | null;
};

const vectorStore = new Chroma(embeddingsModel, {
  collectionName: process.env.CHROMA_COLLECTION_NAME,
});

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 200,
  chunkOverlap: 40,
});

async function main() {
  console.log("Loading docs");

  const agent = createAgent({
    model: chatModel,
  });

  console.log("Fetching data from URL:", DATA_URL);
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch data: ${response.statusText}`);
  }
  const json = await response.json();

  for await (const entry of json.children) {
    console.log("Loading entry", entry.id);

    const response = await agent.invoke({
      messages: [
        extractPrompt,
        new HumanMessage(entry.text.replace(/<[^>]*>?/gm, "")),
      ],
    });

    let responseData: Entry[] | null = null;
    try {
      responseData = JSON.parse(
        response.messages[response.messages.length - 1].content as string
      );

      if (!Array.isArray(responseData)) {
        responseData = [responseData];
      }

      responseData.forEach((data: any) => {
        if (!data.company_name || !data.role_title) {
          throw new Error("Missing required fields");
        }
      });
    } catch (e) {
      console.error("Failed to parse response for entry", entry.id, e);
      continue;
    }

    console.log("extracted data for entry", entry.id, responseData);

    for await (const [roleIndex, role] of responseData.entries()) {
      // Combine all fields into a single text block
      const text = Object.keys(role).reduce((acc, key) => {
        return acc + `${role[key] ? `\n${key}: ${role[key]}` : ""}`;
      }, "");

      const allSplits = await splitter.splitText(
        `Company Name: ${role.company_name},Role Title: ${role.role_title}\n${text}`
      );

      console.log("storing entry", entry.id, text);

      await vectorStore.addDocuments(
        allSplits.map((split, index) => {
          return new Document({
            pageContent: split,
            metadata: {
              role_id: `${entry.id}-${roleIndex}`,
              chunk_id: index,
              entry_id: entry.id,
              doc_id: entry.id,
              thread_id: entry.thread_id,
              author: entry.author,
              time: entry.time,
            },
          });
        })
      );
    }
  }
}

main();
