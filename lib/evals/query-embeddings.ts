import fs from "fs/promises";
import path from "path";
import { slug } from "../extraction/extract";
import { getEmbeddings } from "../../models/embeddings";
import { isNotFound } from "../util/fs";

type Embed = (query: string) => Promise<number[]>;
type CacheFile = { embed_model: string; vectors: Record<string, number[]> };

/** One file per embedding model, so switching models can never serve vectors from another space. */
export const queryEmbeddingsPath = (embedModel: string, dir = "data/evals") =>
  path.join(dir, `query-embeddings.${slug(embedModel)}.json`);

/**
 * Query embeddings for the retrieval eval, cached on disk by (model, query text). After the first
 * run the eval needs no embedding calls: free, unaffected by quota, and bit-for-bit repeatable.
 * Only missing queries are embedded (a new or edited query costs one call).
 */
export async function cachedQueryEmbeddings(
  queries: string[],
  embedModel: string,
  {
    file = queryEmbeddingsPath(embedModel),
    embed = (q: string) => getEmbeddings("query", embedModel).embedQuery(q),
  }: { file?: string; embed?: Embed } = {},
): Promise<{ vectors: Map<string, number[]>; embedded: number }> {
  const cache = await readCache(file, embedModel);
  const missing = [...new Set(queries)].filter((q) => !cache.vectors[q]?.length);
  for (const q of missing) {
    const v = await embed(q);
    if (!v.length) {
      throw new Error(`Empty query embedding for "${q}"`);
    }
    cache.vectors[q] = v;
  }
  if (missing.length) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(cache) + "\n");
  }
  return {
    vectors: new Map(queries.map((q) => [q, cache.vectors[q]])),
    embedded: missing.length,
  };
}

async function readCache(file: string, embedModel: string): Promise<CacheFile> {
  try {
    const cache: CacheFile = JSON.parse(await fs.readFile(file, "utf8"));
    if (cache.embed_model !== embedModel) {
      throw new Error(`${file} holds ${cache.embed_model} vectors, expected ${embedModel}`);
    }
    return cache;
  } catch (e) {
    if (!isNotFound(e)) {
      throw e;
    }
    return { embed_model: embedModel, vectors: {} };
  }
}
