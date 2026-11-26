import type { Role } from "../schema";

/**
 * The text embedded for a role. One document per role (no chunking): roles are short, and
 * splitting them scattered title, location and stack across separate vectors.
 */
export function roleDoc(r: Role): string {
  const where = [
    r.remote_policy,
    r.remote_regions.length ? `(${r.remote_regions.join(", ")})` : null,
    r.locations.map((l) => [l.city, l.region, l.country_code].filter(Boolean).join(", ")).join("; ") || null,
  ].filter(Boolean).join(" ");
  const s = r.salary;
  const salary = s && (s.min || s.max) ? `${s.min ?? "?"}-${s.max ?? "?"} ${s.currency ?? ""}/${s.period ?? "?"}` : null;
  return [
    `${r.role_title ?? "Role"} at ${r.company_name ?? "unknown company"}`,
    r.seniority && `Seniority: ${r.seniority}`,
    r.employment_type && `Employment: ${r.employment_type}`,
    where && `Where: ${where}`,
    r.timezones.length ? `Timezones: ${r.timezones.join(", ")}` : null,
    r.tech_stack.length ? `Tech: ${r.tech_stack.join(", ")}` : null,
    salary && `Salary: ${salary}`,
    r.visa_sponsorship !== null && `Visa sponsorship: ${r.visa_sponsorship ? "yes" : "no"}`,
    r.description,
  ].filter(Boolean).join("\n");
}
