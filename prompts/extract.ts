import { HumanMessage } from "langchain";

const prompt = new HumanMessage(
  `You are an expert at structured data extraction from unstructured text. Limit output strictly to JSON (no explanations).

  You are a job-info extractor.  
  Given the following forum comment, identify all job openings and output a JSON array of objects with this schema:

  {
    "company_name": string,
    "role_title": string,
    "employment_type": string|null, // contract, full-time, part-time, internship, etc. (CRITICAL: can only be one of these values or null)
    "remote_policy": string|null, // remote, hybrid, onsite, etc. (CRITICAL: can only be one of these values or null)
    "locations": string[], (CRITICAL: can only be an array of known place names or empty array)
    "tech_stack": string[],
    "seniority": string|null, // junior, mid, senior, lead, etc. (CRITICAL: can only be one of these values or null)
    "description": string, // summary of the role
    "apply_url": string // URL to apply for the role
  }

  - If multiple roles are described, include each as a separate object.
  - If a field isn't mentioned, use null or an empty list.
  - Normalize tech skills to lowercase, no duplicates.
  - Extract all relevant information that are not captured in other fields into the "description" field..

  Comment:`
);

export default prompt;
