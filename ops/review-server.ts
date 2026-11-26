require("dotenv").config();

import http from "http";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { Role } from "../lib/schema";
import { goldPath, type GoldFile } from "../lib/evals/gold";
import { readExtractions } from "../lib/extraction/extract";
import { PROMPT_VERSION } from "../prompts/extract";

/**
 * Local gold-label review tool.
 * Usage: npm run review [-- --thread 46108941 --port 4777 --blind]
 *   --blind  hide model extractions (no suggestion pills) so labels aren't anchored on a model
 *
 * Bound to 127.0.0.1 only. Never expose this beyond localhost: it writes repo files.
 */
const argv = process.argv;
const argOf = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const THREAD_ID = Number(argOf("thread") ?? process.env.THREAD_ID ?? "46108941");
const BLIND = argv.includes("--blind");
const PORT = Number(argOf("port") ?? process.env.REVIEW_PORT ?? 4777);
const HOST = "127.0.0.1";
const GOLD = goldPath(THREAD_ID);
const PAGE = path.join(__dirname, "..", "review", "index.html");
const MAX_BODY = 1_000_000;

// Defeats DNS rebinding: only answer requests addressed to our own loopback origin.
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

const SaveBody = z.object({
  etag: z.string(),
  status: z.enum(["draft", "reviewed"]),
  notes: z.array(z.string().max(2000)).max(50),
  roles: z.array(Role).max(50),
});

const etagOf = (buf: Buffer | string) => crypto.createHash("sha1").update(buf).digest("hex");

async function readGold(): Promise<{ gold: GoldFile; etag: string }> {
  const raw = await fs.readFile(GOLD);
  return { gold: JSON.parse(raw.toString("utf8")), etag: etagOf(raw) };
}

async function writeAtomic(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file); // atomic on the same filesystem: no half-written gold file
}

// Serialize writes so two quick saves can't interleave read-modify-write.
let writeChain: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
};

// Other models' extractions for the gold postings, current prompt version only.
async function loadExtractions(ids: Set<number>) {
  const dir = "data/extracted";
  const prefix = `${THREAD_ID}.`;
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"));
  } catch {
    return {};
  }
  const out: Record<string, Record<number, z.infer<typeof Role>[]>> = {};
  for (const f of files) {
    for (const r of await readExtractions(path.join(dir, f))) {
      if (r.error || r.prompt_version !== PROMPT_VERSION || !ids.has(r.id)) continue;
      (out[r.model] ??= {})[r.id] = r.roles;
    }
  }
  return out;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const zodMessage = (e: z.ZodError) =>
  e.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) throw new HttpError(421, "Unexpected Host header");
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = await fs.readFile(PAGE);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Page is fully self-contained: no external scripts, styles or connections.
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(html);
  }

  if (req.method === "GET" && url.pathname === "/api/data") {
    const { gold, etag } = await readGold();
    const extractions = BLIND ? {} : await loadExtractions(new Set(gold.postings.map((p) => p.id)));
    return send(res, 200, {
      etag,
      thread_id: gold.thread_id,
      prompt_version: PROMPT_VERSION,
      postings: gold.postings.map((p) => ({
        id: p.id,
        status: p.status,
        seeded_from: p.seeded_from,
        notes: p.notes,
        text: p.text,
        roles: p.roles,
      })),
      extractions,
    });
  }

  const m = url.pathname.match(/^\/api\/postings\/(\d+)$/);
  if (req.method === "PUT" && m) {
    // Cross-origin pages can't forge this: browsers send Origin on PUT.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ""))) throw new HttpError(403, "Cross-origin write refused");
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Expected application/json");

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "Invalid JSON");
    }
    const body = SaveBody.safeParse(parsed);
    if (!body.success) throw new HttpError(422, zodMessage(body.error));

    const id = Number(m[1]);
    const result = await serialized(async () => {
      const { gold, etag } = await readGold();
      if (etag !== body.data.etag) throw new HttpError(409, "Gold file changed on disk since you loaded it. Reload to continue.");
      const target = gold.postings.find((p) => p.id === id);
      if (!target) throw new HttpError(404, `Posting ${id} not in gold set`);

      // Only these fields are editable; id, text and seeded_from are fixed.
      target.status = body.data.status;
      target.notes = body.data.notes.map((n) => n.trim()).filter(Boolean);
      target.roles = body.data.roles;

      const content = JSON.stringify(gold, null, 2) + "\n";
      await writeAtomic(GOLD, content);
      const reviewed = gold.postings.filter((p) => p.status === "reviewed").length;
      return { etag: etagOf(content), reviewed, total: gold.postings.length };
    });
    console.log(`saved ${id} (${body.data.status}) — ${result.reviewed}/${result.total} reviewed`);
    return send(res, 200, { etag: result.etag, reviewed: result.reviewed, total: result.total });
  }

  throw new HttpError(404, "Not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(`${req.method} ${req.url} failed:`, err instanceof Error ? err.message : "unknown error");
    send(res, 500, { error: "Internal error" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Review tool: http://${HOST}:${PORT}  (gold: ${GOLD})`);
});
