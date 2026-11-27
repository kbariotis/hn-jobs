import * as cheerio from "cheerio";
import fs from "fs/promises";
import { isNotFound } from "../util/fs";

export type HNComment = {
  id: number;
  author: string | null;
  created_at_i: number;
  text: string | null;
  parent_id: number | null;
  story_id: number | null;
};

export type Thread = { id: number; title: string; children: HNComment[] };

export type Posting = {
  id: number;
  thread_id: number;
  author: string | null;
  time: number;
  text: string; // cleaned plain text, safe to feed the LLM
};

/**
 * HN comment HTML -> plain text the model can actually read.
 * - <a>: anchor text is truncated by HN ("https://foo/...-"), so use the href.
 * - <p>: HN uses <p> as a paragraph *separator* (no closing tag), so emit a blank line.
 * - <pre>: keep verbatim. Entities (&#x2F;, &#x27;, &amp;) are decoded by cheerio.
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(`<div id="root">${html}</div>`, null, false);

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    $(el).replaceWith(href ?? $(el).text());
  });
  $("p").each((_, el) => {
    $(el).prepend("\n\n");
  });
  $("br").replaceWith("\n");

  return $("#root")
    .text()
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Top-level, non-deleted comments only. Replies are discussion, not postings. */
export function toPostings(thread: Thread): Posting[] {
  return thread.children
    .filter((c) => c.text && c.text.trim().length > 0)
    .map((c) => ({
      id: c.id,
      thread_id: thread.id,
      author: c.author,
      time: c.created_at_i,
      text: htmlToText(c.text!),
    }));
}

export const threadPath = (threadId: string | number) => `data/threads/${threadId}.json`;

/**
 * Prefer the committed snapshot so runs/evals are reproducible; fetch + save otherwise.
 * `save: false` for hosts without a persistent disk (the hosted ingest job): fetch only.
 */
export async function loadThread(
  threadId: string | number,
  { refresh = false, save = true } = {},
): Promise<Thread> {
  const path = threadPath(threadId);
  if (!refresh) {
    try {
      return JSON.parse(await fs.readFile(path, "utf8"));
    } catch (e) {
      if (!isNotFound(e)) {
        throw e;
      }
    }
  }

  const res = await fetch(`https://hn.algolia.com/api/v1/items/${threadId}`);
  if (!res.ok) {
    throw new Error(`HN fetch failed: ${res.status} ${res.statusText}`);
  }
  const thread = (await res.json()) as Thread;
  if (!save) {
    return thread;
  }

  await fs.mkdir("data/threads", { recursive: true });
  await fs.writeFile(path, JSON.stringify(thread));
  return thread;
}

type AlgoliaHit = { objectID: string; title: string; created_at_i: number };

/**
 * Newest "Ask HN: Who is hiring? (Month Year)" story,
 * posted monthly by the whoishiring account.
 */
export async function latestHiringThread(): Promise<{
  id: number;
  title: string;
  created_at_i: number;
}> {
  const url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=20";
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`HN search failed: ${res.status} ${res.statusText}`);
  }
  const { hits } = (await res.json()) as { hits: AlgoliaHit[] };
  // The same account also posts "Who wants to be hired?" and "Freelancer?" threads.
  const hiring = hits
    .filter((h) => /^Ask HN: Who is hiring\?/i.test(h.title))
    .sort((a, b) => b.created_at_i - a.created_at_i);
  if (!hiring.length) {
    throw new Error("No 'Who is hiring?' thread found");
  }
  return {
    id: Number(hiring[0].objectID),
    title: hiring[0].title,
    created_at_i: hiring[0].created_at_i,
  };
}
