require("dotenv").config();

import { Document } from "langchain";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import embeddingsModel from "../models/embeddings";
import { extractedPath, readExtractions } from "../lib/extract";
import { extractModelId } from "../models/extract";
import type { Role } from "../lib/schema";

// Reads extractions produced by `npm run extract` — no LLM calls here.
// Usage: npm run index -- [--thread 46108941]
const threadArg = process.argv.indexOf("--thread");
const THREAD_ID =
  threadArg !== -1 ? process.argv[threadArg + 1] : process.env.THREAD_ID ?? "46108941";

const vectorStore = new Chroma(embeddingsModel, {
  collectionName: process.env.CHROMA_COLLECTION_NAME,
});

// NOTE: chunking intentionally unchanged until retrieval evals have a baseline (Phase 2).
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 200,
  chunkOverlap: 40,
});

const EMBED_TIMEOUT = 30_000;

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const backoffMs = 2 ** (attempt - 1) * 1000;
        console.log(`  ⚠ ${label} attempt ${attempt} failed. Retrying in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastError;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function roleToText(role: Role): string {
  const salary = role.salary
    ? `${role.salary.min ?? "?"}-${role.salary.max ?? "?"} ${role.salary.currency ?? ""}/${role.salary.period ?? ""}`
    : null;
  const locations = role.locations.map((l) => [l.city, l.region, l.country_code].filter(Boolean).join(", "));
  const fields: Record<string, unknown> = { ...role, salary, locations };
  return Object.entries(fields)
    .filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
}

async function main() {
  const modelId = extractModelId();
  const path = extractedPath(THREAD_ID, modelId);
  const records = (await readExtractions(path)).filter((r) => !r.error);
  if (records.length === 0) {
    throw new Error(`No extractions at ${path}. Run \`npm run extract\` first.`);
  }
  console.log(`Indexing ${records.length} extracted postings from ${path}`);

  let embedded = 0;
  for (const rec of records) {
    const docs: Document[] = [];
    for (let roleIndex = 0; roleIndex < rec.roles.length; roleIndex++) {
      const role = rec.roles[roleIndex];
      const splits = await splitter.splitText(
        `Company Name: ${role.company_name},Role Title: ${role.role_title}\n${roleToText(role)}`
      );
      splits.forEach((split, chunk_id) =>
        docs.push(
          new Document({
            pageContent: split,
            metadata: {
              role_id: `${rec.id}-${roleIndex}`,
              chunk_id,
              entry_id: rec.id,
              doc_id: rec.id,
              thread_id: rec.thread_id,
              author: rec.author ?? "",
              time: rec.time,
            },
          })
        )
      );
    }
    if (docs.length === 0) continue; // not a job posting

    try {
      await withRetry(
        () => withTimeout(vectorStore.addDocuments(docs), EMBED_TIMEOUT, `embed ${rec.id}`),
        2,
        `embed ${rec.id}`
      );
      embedded++;
      console.log(`  ✓ ${rec.id}: ${rec.roles.length} role(s), ${docs.length} chunks`);
    } catch (err) {
      console.error(`✗ ${rec.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`✓ Indexing complete. Embedded ${embedded}/${records.length} postings.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
