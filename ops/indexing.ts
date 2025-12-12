import { Document } from "langchain";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import embeddingsModel from "../models/embeddings";

const json = require("./hn.json");

const vectorStore = new Chroma(embeddingsModel, {
  collectionName: "a-test-collection",
});

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 200,
  chunkOverlap: 40,
});

async function main() {
  console.log("Loading docs");

  for await (const chunk of json) {
    console.log("loading chunk", chunk.id);
    const allSplits = await splitter.splitDocuments([
      new Document({
        pageContent: `HN job post (comment ${chunk.id}) ${chunk.text.replace(
          /<[^>]*>?/gm,
          ""
        )}`,
        metadata: {
          chunk_id: chunk.id,
          doc_id: chunk.id,
          thread_id: chunk.thread_id,
          author: chunk.author,
          time: chunk.time,
        },
      }),
    ]);
    console.log("storing chunk", chunk.id);
    await vectorStore.addDocuments(allSplits);
  }
}

main();
