import type { Role } from "../lib/schema";
import { availableIn } from "../lib/geo";

/**
 * Retrieval eval queries. Relevance is a predicate over role labels (gold where reviewed,
 * Flash extractions elsewhere), so judgments are complete and auditable instead of hand-picked.
 *
 * kind:
 *  - structured: the query states constraints that exist as fields. Relevance = those fields.
 *  - semantic:   topic/domain queries with no field behind them. Relevance = a keyword
 *                regex over the posting text (a weaker "silver" judgment; read results with that in mind).
 *
 * Write the query the way a user would type it; write the predicate as what a correct answer must satisfy.
 */
export type Ctx = { text: string };
export type RetrievalQuery = { id: string; query: string; kind: "structured" | "semantic"; relevant: (r: Role, ctx: Ctx) => boolean };

const has = (r: Role, ...tech: string[]) => tech.every((t) => r.tech_stack.includes(t));
const inCity = (r: Role, city: string) => r.locations.some((l) => l.city === city);
const inCountry = (r: Role, cc: string) => r.locations.some((l) => l.country_code === cc);
const remote = (r: Role) => r.remote_policy === "remote";
const usdYear = (r: Role) => (r.salary?.currency === "USD" && r.salary.period === "year" ? r.salary.max ?? r.salary.min : null);

export const QUERIES: RetrievalQuery[] = [
  // --- tech ---
  { id: "remote-rust", kind: "structured", query: "remote Rust jobs", relevant: (r) => remote(r) && has(r, "rust") },
  { id: "k8s-terraform", kind: "structured", query: "Kubernetes and Terraform infrastructure roles", relevant: (r) => has(r, "kubernetes", "terraform") },
  { id: "pytorch", kind: "structured", query: "machine learning engineer using PyTorch", relevant: (r) => has(r, "pytorch") },
  { id: "react-ts-europe", kind: "structured", query: "React and TypeScript jobs in Europe", relevant: (r) => has(r, "react", "typescript") && availableIn(r, "EUROPE") },
  { id: "go-sf", kind: "structured", query: "Go developer in San Francisco", relevant: (r) => has(r, "go") && inCity(r, "San Francisco") },
  { id: "postgres-berlin", kind: "structured", query: "Postgres jobs in Berlin", relevant: (r) => has(r, "postgres") && inCity(r, "Berlin") },
  // --- location / work mode ---
  { id: "london", kind: "structured", query: "jobs in London", relevant: (r) => inCity(r, "London") },
  { id: "onsite-nyc", kind: "structured", query: "onsite roles in NYC", relevant: (r) => r.remote_policy === "onsite" && inCity(r, "New York") },
  { id: "hybrid-germany", kind: "structured", query: "hybrid roles in Germany", relevant: (r) => r.remote_policy === "hybrid" && inCountry(r, "DE") },
  { id: "remote-canada", kind: "structured", query: "remote jobs I can do from Canada", relevant: (r) => remote(r) && availableIn(r, "CA") },
  { id: "remote-latam", kind: "structured", query: "remote roles open to Latin America", relevant: (r) => remote(r) && availableIn(r, "LATAM") },
  { id: "remote-worldwide", kind: "structured", query: "fully remote jobs open worldwide", relevant: (r) => remote(r) && r.remote_regions.includes("GLOBAL") },
  // --- level / type / comp ---
  { id: "senior-python-us", kind: "structured", query: "senior Python engineer, remote in the US", relevant: (r) => remote(r) && r.seniority === "senior" && has(r, "python") && availableIn(r, "US") },
  { id: "staff", kind: "structured", query: "staff engineer positions", relevant: (r) => r.seniority === "staff" },
  { id: "eng-manager-remote", kind: "structured", query: "remote engineering manager", relevant: (r) => remote(r) && r.seniority === "manager" && /engineer/i.test(r.role_title ?? "") },
  { id: "internships", kind: "structured", query: "internships", relevant: (r) => r.employment_type === "internship" || r.seniority === "intern" },
  { id: "contract", kind: "structured", query: "contract work", relevant: (r) => r.employment_type === "contract" },
  { id: "visa", kind: "structured", query: "companies that sponsor visas", relevant: (r) => r.visa_sponsorship === true },
  { id: "senior-200k", kind: "structured", query: "senior roles paying over $200k", relevant: (r) => r.seniority === "senior" && (usdYear(r) ?? 0) >= 200_000 },
  // --- semantic (silver) ---
  { id: "robotics", kind: "semantic", query: "robotics companies", relevant: (_, c) => /\brobot/i.test(c.text) },
  { id: "healthcare", kind: "semantic", query: "healthcare startups", relevant: (_, c) => /\b(health ?care|clinical|patients?|medical)\b/i.test(c.text) },
  { id: "fintech", kind: "semantic", query: "fintech and payments", relevant: (_, c) => /\b(fintech|payments?|banking)\b/i.test(c.text) },
  { id: "climate", kind: "semantic", query: "climate tech and energy", relevant: (_, c) => /\b(climate|decarboni[sz]|carbon|solar|batter(y|ies)|grid|energy)\b/i.test(c.text) },
  { id: "security", kind: "semantic", query: "security engineer", relevant: (r) => /security/i.test(r.role_title ?? "") },
];
