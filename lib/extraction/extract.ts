import { HumanMessage } from "langchain";
import fs from "fs/promises";
import { createHash } from "crypto";
import { Extraction, type Role } from "../schema";
import { toGeminiSchema } from "../../models/gemini-schema";
import { groundRoles, type GroundingWarning } from "./grounding";
import { canonicalizeRoles } from "../canonical";
import { RateLimiter, withBackoff } from "../util/rate";
import type { Posting } from "./hn";
import extractPrompt, { PROMPT_VERSION } from "../../prompts/extract";
import { getExtractModel } from "../../models/extract";

export type ExtractionRecord = {
  id: number;
  thread_id: number;
  author: string | null;
  time: number;
  model: string;
  prompt_version: string;
  latency_ms: number;
  text_sha?: string; // hash of the input text; a changed hash (edited HN comment) means re-extract
  roles: Role[];
  warnings?: GroundingWarning[]; // values dropped by canonicalization or the grounding guard
  error?: string; // set on failure; roles = [] in that case
};

type StructuredModel = { invoke: (input: any, config?: any) => Promise<unknown> };

export async function buildExtractor(modelId: string): Promise<StructuredModel> {
  const model = await getExtractModel(modelId);
  // Gemini can't take nullable unions as JSON Schema; hand it an adapted schema.
  // Output is still validated against the Zod schema in extractPosting.
  const schema = modelId.startsWith("google-genai:") ? toGeminiSchema(Extraction) : Extraction;
  return model.withStructuredOutput(schema, { name: "extract_jobs" });
}

export async function extractPosting(
  extractor: StructuredModel,
  modelId: string,
  posting: Posting,
  { timeoutMs = 120_000, limiter }: { timeoutMs?: number; limiter?: RateLimiter } = {}
): Promise<ExtractionRecord> {
  const base = {
    id: posting.id,
    thread_id: posting.thread_id,
    author: posting.author,
    time: posting.time,
    model: modelId,
    prompt_version: PROMPT_VERSION,
    text_sha: textSha(posting.text),
  };
  const started = Date.now();
  try {
    // Each attempt waits for a limiter slot; 429s back off and retry instead of failing the posting.
    const raw = await withBackoff(
      async () => {
        await limiter?.acquire();
        return extractor.invoke([extractPrompt, new HumanMessage(posting.text)], { timeout: timeoutMs });
      },
      { onRetry: (n, ms) => console.warn(`  ↻ ${posting.id}: rate limited, retry ${n} in ${Math.round(ms / 1000)}s`) }
    );
    // Providers differ in how strictly they honour the schema — validate regardless.
    const parsed = Extraction.parse(raw);
    const canon = canonicalizeRoles(parsed.roles); // same normalization as gold labels
    const { roles, warnings: groundWarnings } = groundRoles(canon.roles, posting.text);
    const warnings = [...canon.warnings, ...groundWarnings];
    return {
      ...base,
      latency_ms: Date.now() - started,
      roles,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    return {
      ...base,
      latency_ms: Date.now() - started,
      roles: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const textSha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Up to date = succeeded, same prompt version, same input text (older records lack a hash: trust them). */
export const isFresh = (r: ExtractionRecord, text: string) =>
  !r.error && r.prompt_version === PROMPT_VERSION && (!r.text_sha || r.text_sha === textSha(text));

export const slug = (modelId: string) => modelId.replace(/[^a-zA-Z0-9.-]+/g, "_");

export const extractedPath = (threadId: string | number, modelId: string) =>
  `data/extracted/${threadId}.${slug(modelId)}.jsonl`;

export async function readExtractions(path: string): Promise<ExtractionRecord[]> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
