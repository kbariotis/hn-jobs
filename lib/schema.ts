import { z } from "zod";

// Enums are enforced at decode time via structured output — not by "CRITICAL" in the prompt.
export const EmploymentType = z.enum(["full-time", "part-time", "contract", "internship"]);
export const RemotePolicy = z.enum(["remote", "hybrid", "onsite"]);
export const Seniority = z.enum([
  "intern",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "lead",
  "manager",
  "director",
  "executive",
]);

export const Salary = z.object({
  min: z.number().nullable().describe("Lower bound as a plain number, e.g. 165000 for $165k"),
  max: z
    .number()
    .nullable()
    .describe("Upper bound as a plain number; same as min if a single figure"),
  currency: z.string().nullable().describe("ISO 4217 code, e.g. USD, EUR, GBP"),
  period: z.enum(["year", "month", "hour"]).nullable(),
});

export const MACRO_REGIONS = ["EUROPE", "EMEA", "LATAM", "APAC", "AMERICAS", "GLOBAL"] as const;

export const Location = z.object({
  city: z
    .string()
    .nullable()
    .describe(
      "City as written, abbreviations expanded (NYC -> New York). null if only a country is given",
    ),
  region: z
    .string()
    .nullable()
    .describe("US state / Canadian province code (NY, CA, ON), else null"),
  country_code: z.string().nullable().describe("ISO 3166-1 alpha-2, e.g. US, GB, NL, IN"),
});

export const Role = z.object({
  company_name: z.string(),
  role_title: z.string().describe("One role title as written, e.g. 'Senior Software Engineer'"),
  employment_type: EmploymentType.nullable(),
  remote_policy: RemotePolicy.nullable(),
  remote_regions: z
    .array(z.string())
    .describe(
      `Where remote hires may live: ISO alpha-2 country codes or one of ${MACRO_REGIONS.join(", ")}. e.g. ["US","CA"], ["EUROPE"]. Empty if not remote or unstated`,
    ),
  timezones: z
    .array(z.string())
    .describe(
      "Timezone constraints as written, e.g. 'CET', 'US Pacific hours'. Never put timezones in remote_regions",
    ),
  locations: z
    .array(Location)
    .describe("Office locations. Empty if none mentioned. Never 'Remote'"),
  seniority: Seniority.nullable(),
  tech_stack: z
    .array(z.string())
    .describe("Technologies explicitly named in the post, lowercase, no duplicates"),
  salary: Salary.nullable().describe("null if no compensation figures are stated"),
  visa_sponsorship: z
    .boolean()
    .nullable()
    .describe("true/false only if the post says so explicitly"),
  apply_url: z
    .string()
    .nullable()
    .describe("A URL from the post for applying or for the job listing; null if none"),
  apply_email: z.string().nullable(),
  description: z.string().describe("1-3 sentence summary of the company and role"),
});

// Wrapped in an object: tool/function-calling providers require an object root.
export const Extraction = z.object({
  roles: z
    .array(Role)
    .describe("One entry per distinct role. Empty array if the comment is not a job posting"),
});

export type Role = z.infer<typeof Role>;
export type Location = z.infer<typeof Location>;
export type Extraction = z.infer<typeof Extraction>;
