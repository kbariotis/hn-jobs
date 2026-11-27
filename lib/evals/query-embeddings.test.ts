import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cachedQueryEmbeddings, queryEmbeddingsPath } from "./query-embeddings";

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), "qemb-"));

test("embeds only missing queries and reuses the cache on the next run", async () => {
  const file = queryEmbeddingsPath("google-genai:m1", await tmpDir());
  const calls: string[] = [];
  const embed = async (q: string) => {
    calls.push(q);
    return [q.length, 1];
  };

  const first = await cachedQueryEmbeddings(["a", "bb"], "google-genai:m1", { file, embed });
  assert.equal(first.embedded, 2);
  assert.deepEqual(first.vectors.get("bb"), [2, 1]);

  const second = await cachedQueryEmbeddings(["a", "bb", "ccc"], "google-genai:m1", {
    file,
    embed,
  });
  assert.equal(second.embedded, 1);
  assert.deepEqual(calls, ["a", "bb", "ccc"]);
});

test("is keyed by model: a file is never read for another model", async () => {
  const dir = await tmpDir();
  assert.notEqual(queryEmbeddingsPath("google-genai:m1", dir), queryEmbeddingsPath("x:m2", dir));

  const file = queryEmbeddingsPath("google-genai:m1", dir);
  await cachedQueryEmbeddings(["a"], "google-genai:m1", { file, embed: async () => [1] });
  await assert.rejects(
    cachedQueryEmbeddings(["a"], "x:m2", { file, embed: async () => [2] }),
    /expected x:m2/,
  );
});

test("rejects empty vectors instead of caching them", async () => {
  const file = queryEmbeddingsPath("m", await tmpDir());
  await assert.rejects(
    cachedQueryEmbeddings(["a"], "m", { file, embed: async () => [] }),
    /Empty query embedding/,
  );
});
