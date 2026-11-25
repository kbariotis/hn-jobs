import type { Role } from "./schema";

export type GoldPosting = {
  id: number;
  // draft: model output awaiting review. reviewed: human-verified, safe to score against.
  status: "draft" | "reviewed";
  seeded_from: string; // "<provider:model>@prompt-v<N>" the draft came from
  notes: string[]; // labelling decisions and open questions
  text: string; // cleaned input at labelling time; lets evals detect preprocessing drift
  roles: Role[];
};

export type GoldFile = { thread_id: number; schema_version?: number; postings: GoldPosting[] };

export const goldPath = (threadId: string | number) => `data/gold/extract.${threadId}.json`;
