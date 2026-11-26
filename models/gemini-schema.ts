import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { ZodTypeAny } from "zod";

// Walks arbitrary JSON Schema; a precise type would just be casts everywhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const isNull = (s: Json) => s && s.type === "null";

/**
 * Gemini's responseSchema is a proto-backed OpenAPI 3.0 subset: it rejects
 * `type: ["string","null"]` and `anyOf: [X, {type: "null"}]` and wants `nullable: true`.
 * Convert Zod -> JSON Schema -> that subset, keeping Zod as the single source of truth.
 */
export function toGeminiSchema(schema: ZodTypeAny): Json {
  // Cast: toJsonSchema's generic over a deep Zod type trips TS2589.
  return normalize((toJsonSchema as (s: unknown) => Json)(schema));
}

function normalize(node: Json): Json {
  if (Array.isArray(node)) return node.map(normalize) as unknown as Json;
  if (!node || typeof node !== "object") return node;

  const { $schema: _schema, additionalProperties: _additional, anyOf, type, ...rest } = node; // dropped: Gemini rejects them
  let out: Json = { ...rest };

  if (Array.isArray(type)) {
    const nonNull = type.filter((t: string) => t !== "null");
    if (nonNull.length !== 1) throw new Error(`Unsupported union type for Gemini: ${type}`);
    out.type = nonNull[0];
    if (nonNull.length !== type.length) out.nullable = true;
  } else if (type !== undefined) {
    out.type = type;
  }

  if (anyOf) {
    const nonNull = anyOf.filter((s: Json) => !isNull(s));
    if (nonNull.length !== 1) throw new Error("Unsupported anyOf for Gemini (only X | null)");
    // Outer description wins over the inner one.
    out = { ...normalize(nonNull[0]), ...out };
    if (nonNull.length !== anyOf.length) out.nullable = true;
  }

  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, normalize(v as Json)]));
  }
  if (out.items) out.items = normalize(out.items);
  return out;
}
