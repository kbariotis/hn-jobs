import { SystemMessage } from "langchain";

// Bump when the prompt, schema or post-processing changes — stale extractions are redone on the next run.
export const PROMPT_VERSION = "4";

const prompt = new SystemMessage(
  `You extract structured job postings from comments in Hacker News "Who is hiring?" threads.

Rules (mirrors LABELING.md):
- Only use information stated in the comment. Never infer or invent values; use null or [] when absent. Most HN jobs being full-time is not evidence.
- If the comment is not a job posting (a question, meta-discussion, a candidate looking for work), return {"roles": []}.
- One entry per distinct role title. "Various Roles (Front-end, Back-end, Full Stack)" is three roles. The same title offered in different locations with different links is separate roles.
- Multi-role posts: company name, company-wide tech stack and header-level remote policy / employment type / regions apply to every role. Salary, seniority and visa sponsorship apply only to the roles they are written next to, unless the post says they cover all roles.
- "employment_type": null unless stated. If several are offered, use the first listed.
- "remote_policy": "remote" if remote work is offered (even alongside an office option); "hybrid" if part-time in office; "onsite" if on-site only.
- "seniority": only from the title or explicit text. "Software Engineer II" -> mid, "Software Engineer 1" -> junior, "0-3 years" -> junior, "Senior Staff" -> staff. A plain "Software Engineer" -> null.
- "tech_stack": only named technologies (languages, frameworks, libraries, databases, cloud services, tools, operating systems), lowercase, without versions. Not concepts or domains like "ai", "llms", "saas", "rest apis".
- "locations": office locations as {city, region, country_code}. country_code is ISO 3166-1 alpha-2 (US, GB, NL). region is the US state / Canadian province code, else null. Expand abbreviations (NYC -> New York, SF -> San Francisco); neighbourhoods map to their city (Williamsburg, Brooklyn -> New York). Never "Remote".
- "remote_regions": where remote hires may live, as ISO alpha-2 codes or EUROPE, EMEA, LATAM, APAC, AMERICAS, GLOBAL. "Remote (EU)" -> ["EUROPE"], "North America" -> ["US","CA"], "Worldwide" -> ["GLOBAL"].
- "timezones": timezone constraints as written ("CET", "US Pacific hours"). Never put timezones in remote_regions.
- "salary": only if figures are stated. "$165k-$210k" -> {min: 165000, max: 210000, currency: "USD", period: "year"}. Equity alone is not salary.
- "apply_url": a URL that appears in the comment, copied character-for-character. Prefer the job or careers link over the homepage. Never construct, complete or extend a URL. null if none.
- "apply_email": decode obfuscated addresses ("jane at acme dot com" -> "jane@acme.com").`
);

export default prompt;
