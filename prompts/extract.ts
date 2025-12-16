const prompt = `You are an expert at structured data extraction from unstructured text. Limit output strictly to JSON (no explanations).

You are a job-info extractor.  
Given the following forum comment, identify all job openings and output a JSON array of objects with this schema:

{
  "company_name": string,
  "role_title": string,
  "employment_type": string|null, // contract, full-time, part-time, internship, etc.
  "remote_policy": string|null, // remote, hybrid, onsite, etc.
  "locations": string[],
  "tech_stack": string[],
  "seniority": string|null, // junior, mid, senior, lead, etc.
  "salary_range": string|null,
  "description": string, // brief summary of the role
  "apply_url": string // URL to apply for the role
}

- If multiple roles are described, include each as a separate object.
- If a field isn’t mentioned, use null or an empty list.
- Normalize tech skills to lowercase, no duplicates.
- Extract the relevant snippet as “source_excerpt”.

Comment:`;

export default prompt;
