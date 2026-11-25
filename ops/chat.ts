require("dotenv").config();

import readline from "readline/promises";
import { createAgent, SystemMessage, tool, HumanMessage } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import chatModel from "../models/chat";
import { db } from "../lib/db";
import { search } from "../lib/search";

const checkpointer = new MemorySaver();
const THREAD_ID = Number(process.env.THREAD_ID ?? "46108941");

// Filtered strategy: the LLM-parsed constraints (remote, region, stack, level...) become SQL
// filters, then roles are ranked by vector similarity. See eval:retrieval for how it scores.
const retrieve = tool(
  async ({ query }) => {
    const { hits, filters } = await search(query, { strategy: "filtered", threadId: THREAD_ID, k: 10 });
    console.log(`Retrieved ${hits.length} roles`, JSON.stringify(filters));
    if (hits.length === 0) return "No matching roles found.";
    const { rows } = await db().query<{ role_id: string; doc: string; apply_url: string | null; apply_email: string | null }>(
      "SELECT role_id, doc, apply_url, apply_email FROM roles WHERE role_id = ANY($1)",
      [hits.map((h) => h.role_id)]
    );
    const byId = new Map(rows.map((r) => [r.role_id, r]));
    return hits
      .map((h) => byId.get(h.role_id))
      .filter((r) => r !== undefined)
      .map((r) => `ROLE ID: ${r.role_id}\n${r.doc}\nApply: ${r.apply_url ?? r.apply_email ?? "see HN post"}`)
      .join("\n---\n");
  },
  {
    name: "retrieve",
    description: "Retrieve jobs matching the users' query.",
    schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  }
);

const systemPrompt = new SystemMessage(
  [
    "You're a recruiter assistant bot (CRITICAL: You're only that and nothing else) that helps users with their job search. Your expertise is on tech related roles and your main source of related open roles is the monthly Hacker News Who is Hiring thread. You have access to a tool that retrieves context for you based on the user's query but in order for it to work best you need to get as much information from the user as possible about what they are looking for.",
    "Always interpret the user’s intent and, if the question is outside job-related topics (jobs, hiring, roles, applications, companies, career advice), you should answer in a way that relates it back to jobs. For example, ask how their question connects to work or careers, or provide job-related insight. Do not engage fully in unrelated topics.",
    "Be concise, helpful and always reply back weather you have found the information or not, with suggestions for the user to find the information themselves if you don't have it.",
    "Before answering the user's query, make sure that you have all relative information in the context.",
    "CRITICAL: DO NOT HALLUCINATE INFORMATION THAT DO NOT EXIST IN THE CONTEXT. IF YOU CANNOT FIND THE INFORMATION, SAY YOU CANNOT FIND IT RATHER THAN MAKING IT UP.",
  ].join(" ")
);

const agent = createAgent({
  model: chatModel,
  tools: [retrieve],
  systemPrompt,
  checkpointer,
});

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "Assistant> ",
  });

  rl.prompt();

  for await (const line of rl) {
    if (line.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
    } else if (line.trim() === "") {
      rl.prompt();
    } else {
      const response = await agent.invoke(
        {
          messages: [new HumanMessage(line)],
        },
        {
          configurable: { thread_id: new Date().getTime() },
        }
      );
      console.log(
        response.messages[response.messages.length - 1].content as string
      );

      rl.prompt();
    }
  }
}

main().catch(console.error);
