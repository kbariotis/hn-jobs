require("dotenv").config();

import { createAgent, Document, HumanMessage } from "langchain";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import embeddingsModel from "../models/embeddings";
import extractModel from "../models/extract";
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

let processedEntries = 0;
const VECTOR_BATCH_SIZE = 2; // Embed every X items
const LLM_TIMEOUT = 600000; // 10 minutes timeout for LLM calls (Ollama can be slow)

// Timeout wrapper for promises
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      )
    ),
  ]);
}

// Retry wrapper with exponential backoff
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  label: string = "Operation"
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        console.log(
          `  ⚠ ${label} attempt ${attempt} failed: ${lastError.message}. Retrying in ${backoffMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw lastError;
}

async function extractEntryData(
  agent: any,
  entry: any
): Promise<{ entry: any; data: Entry[] } | null> {
  try {
    console.log(`  Extracting entry ${entry.id}...`);

    const response = await withRetry<{ messages: { content: string }[] }>(
      () =>
        withTimeout(
          agent.invoke({
            messages: [
              extractPrompt,
              new HumanMessage(entry.text.replace(/<[^>]*>?/gm, "")),
            ],
          }),
          LLM_TIMEOUT,
          `Entry ${entry.id}`
        ),
      3,
      `Entry ${entry.id} extraction`
    );

    let responseData: Entry[] | null = null;
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

    console.log(
      `  ✓ Entry ${entry.id} extracted (${responseData.length} role(s))`
    );
    return { entry, data: responseData };
  } catch (e) {
    console.error(
      `✗ Failed to extract entry ${entry.id}:`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

async function main() {
  console.log("Loading docs");

  const agent = createAgent({
    model: extractModel,
  });

  console.log("Fetching data from URL:", DATA_URL);
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch data: ${response.statusText}`);
  }
  const json = await response.json();
  const entries = json.children;
  const totalEntries = entries.length;

  // Queue for vector store operations
  const vectorStoreQueue: Promise<void>[] = [];

  // Extract and process all entries sequentially
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    console.log(`Processing entry ${i + 1}/${totalEntries}`);

    const result = await extractEntryData(agent, entry);

    // Process extracted data and queue vector insertions
    if (result) {
      const { entry, data } = result;

      for (let roleIndex = 0; roleIndex < data.length; roleIndex++) {
        const role = data[roleIndex];
        // Combine all fields into a single text block
        const text = Object.keys(role).reduce((acc, key) => {
          return acc + `${role[key] ? `\n${key}: ${role[key]}` : ""}`;
        }, "");

        const allSplits = await splitter.splitText(
          `Company Name: ${role.company_name},Role Title: ${role.role_title}\n${text}`
        );

        // Queue the vector store operation with timeout
        const docs = allSplits.map((split, index) => {
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
        });

        const vectorOp = withRetry(
          () =>
            withTimeout(
              vectorStore.addDocuments(docs),
              30000,
              `Vector embed for ${entry.id}`
            ),
          2,
          `Vector embed for ${entry.id}`
        )
          .then(() => {
            console.log(
              `  ✓ Embedded ${allSplits.length} chunks for entry ${entry.id}`
            );
            return undefined;
          })
          .catch((err) => {
            console.error(
              `✗ Failed to add documents for entry ${entry.id}:`,
              err instanceof Error ? err.message : err
            );
          });

        vectorStoreQueue.push(vectorOp);

        // Process vector batch every VECTOR_BATCH_SIZE items
        if (vectorStoreQueue.length >= VECTOR_BATCH_SIZE) {
          console.log(
            `Waiting for ${vectorStoreQueue.length} vector operations to complete...`
          );
          await Promise.all(vectorStoreQueue.splice(0, VECTOR_BATCH_SIZE));
        }
      }

      processedEntries++;
    }
  }

  // Wait for remaining vector store operations
  if (vectorStoreQueue.length > 0) {
    console.log(
      `Waiting for ${vectorStoreQueue.length} remaining operations...`
    );
    await Promise.all(vectorStoreQueue);
  }

  console.log(`✓ Indexing complete. Processed ${processedEntries} entries.`);
}

main();
