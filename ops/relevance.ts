import { Chroma } from "@langchain/community/vectorstores/chroma";
import embeddingsModel from "../models/embeddings";

const results = require("./gs2.json");

const vectorStore = new Chroma(embeddingsModel, {
  collectionName: "a-test-collection",
});

async function main() {
  const agg = [];
  console.log("Performing queries");
  for await (const item of results) {
    const retrievedDocs = await vectorStore.similaritySearch(item.query, 10);
    const serialized = retrievedDocs
      .map((doc) => doc.metadata.doc_id)
      .join(", ");

    console.log(item.query, "\n", item.matches.join(", "), "\n", serialized);
    const metrics = metricsForQuery(
      retrievedDocs.map((doc) => doc.metadata.doc_id),
      item.matches,
      10
    );

    agg.push(metrics);

    console.log("Metrics:", metrics);
    console.log("-----");
  }
}

function metricsForQuery(
  retrievedDocIds: number[],
  relevantDocIds: number[],
  k: number
): { hit: number; recall: number; rr: number } {
  const relevant = new Set<(typeof relevantDocIds)[number]>(relevantDocIds);
  const retrievedAtK = retrievedDocIds.slice(0, k);

  // Hit@K
  const hit = retrievedAtK.some((docId) => relevant.has(docId)) ? 1 : 0;

  // Recall@K
  const retrievedRelevant = retrievedAtK.filter((docId) =>
    relevant.has(docId)
  ).length;
  const recall = relevant.size > 0 ? retrievedRelevant / relevant.size : 0;

  // MRR
  let rr = 0;
  for (let idx = 0; idx < retrievedDocIds.length; idx++) {
    if (relevant.has(retrievedDocIds[idx])) {
      rr = 1 / (idx + 1);
      break;
    }
  }

  return { hit, recall, rr };
}

main().catch(console.error);
