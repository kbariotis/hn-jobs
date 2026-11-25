import { MACRO_REGIONS, type Location, type Role } from "./schema";

/**
 * Deterministic normalization applied to BOTH model output and gold labels (see LABELING.md).
 * Spelling/format variance is handled here so evals measure extraction, not orthography.
 * Keep tables small and boring; anything ambiguous belongs in a labelling rule, not here.
 */

// ---------- tech ----------
const TECH_ALIASES: Record<string, string> = {
  golang: "go",
  "node.js": "node",
  nodejs: "node",
  postgresql: "postgres",
  ts: "typescript",
  js: "javascript",
  "next.js": "nextjs",
  "vue.js": "vue",
  k8s: "kubernetes",
  "react.js": "react",
  reactjs: "react",
  tailwindcss: "tailwind",
  "amazon web services": "aws",
  "google cloud": "gcp",
  "google cloud platform": "gcp",
};

// Concepts/domains/protocols: not technologies per LABELING.md.
const NOT_TECH = new Set(["ai", "ml", "llm", "llms", "llm apis", "genai", "saas", "rest apis", "rest api", "apis", "http", "iot", "cloud", "web"]);

export function canonicalTech(raw: string): string | null {
  let t = raw.trim().toLowerCase();
  // Versions: "react 19", "tailwind v4", "qt 6.9", "c++23", "react router 7"
  t = t.replace(/\s+v?\d+(\.\d+)*$/, "").replace(/^(c\+\+|c#)\d+$/, "$1");
  t = TECH_ALIASES[t] ?? t;
  return !t || NOT_TECH.has(t) ? null : t;
}

// ---------- regions ----------
const REGION_ALIASES: Record<string, string[]> = {
  usa: ["US"], us: ["US"], "united states": ["US"], america: ["US"],
  canada: ["CA"], uk: ["GB"], "united kingdom": ["GB"], england: ["GB"],
  eu: ["EUROPE"], europe: ["EUROPE"], "european union": ["EUROPE"],
  "north america": ["US", "CA"], "latin america": ["LATAM"], latam: ["LATAM"], "south america": ["LATAM"],
  emea: ["EMEA"], apac: ["APAC"], asia: ["APAC"], americas: ["AMERICAS"],
  global: ["GLOBAL"], worldwide: ["GLOBAL"], anywhere: ["GLOBAL"],
};
const COUNTRY_NAMES: Record<string, string> = {
  singapore: "SG", india: "IN", germany: "DE", netherlands: "NL", "the netherlands": "NL", france: "FR",
  spain: "ES", portugal: "PT", poland: "PL", belgium: "BE", switzerland: "CH", sweden: "SE", ireland: "IE",
  italy: "IT", israel: "IL", australia: "AU", brazil: "BR", mexico: "MX", argentina: "AR", japan: "JP",
  austria: "AT", denmark: "DK", norway: "NO", finland: "FI", "czech republic": "CZ", greece: "GR",
};
const TZ_HINT = /\b(time ?zones?|hours|tz|utc|gmt|[cpme][es]?t|cest|pst|est|cst|mst|bst)\b/i;
const MACROS = new Set<string>(MACRO_REGIONS);

/** Map a remote-region string to codes. Timezones are returned separately, unknowns are reported. */
export function canonicalRegion(raw: string): { codes: string[]; timezone?: string; unknown?: string } {
  const s = raw.trim();
  const k = s.toLowerCase().replace(/\s+only$/, "");
  // Aliases first: "EU" and "UK" look like ISO alpha-2 codes but aren't country codes.
  if (REGION_ALIASES[k]) return { codes: REGION_ALIASES[k] };
  if (/^[A-Z]{2}$/.test(s) || MACROS.has(s)) return { codes: [s] };
  if (TZ_HINT.test(s)) return { codes: [], timezone: s };
  if (COUNTRY_NAMES[k]) return { codes: [COUNTRY_NAMES[k]] };
  return { codes: [], unknown: s };
}

export function countryCode(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase() === "UK" ? "GB" : s.toUpperCase();
  const k = s.toLowerCase();
  return REGION_ALIASES[k]?.length === 1 && /^[A-Z]{2}$/.test(REGION_ALIASES[k][0]) ? REGION_ALIASES[k][0] : COUNTRY_NAMES[k] ?? s;
}

const CITY_ALIASES: Record<string, string> = { nyc: "New York", "new york city": "New York", sf: "San Francisco", "sf bay area": "San Francisco Bay Area", la: "Los Angeles", dc: "Washington" };

export function canonicalLocation(loc: Location): Location {
  const city = loc.city?.trim() || null;
  return {
    city: city ? CITY_ALIASES[city.toLowerCase()] ?? city : null,
    region: loc.region?.trim().toUpperCase() || null,
    country_code: countryCode(loc.country_code),
  };
}

const uniq = <T>(xs: T[], key: (x: T) => string = String) => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};

export type CanonicalWarning = { role_index: number; field: string; value: string };

/** Normalize a role list. Pure: returns new objects; reports values it could not map. */
export function canonicalizeRoles(roles: Role[]): { roles: Role[]; warnings: CanonicalWarning[] } {
  const warnings: CanonicalWarning[] = [];
  const out = roles.map((r, role_index) => {
    const codes: string[] = [];
    const timezones = [...r.timezones];
    for (const reg of r.remote_regions) {
      const c = canonicalRegion(reg);
      codes.push(...c.codes);
      if (c.timezone) timezones.push(c.timezone);
      if (c.unknown) warnings.push({ role_index, field: "remote_regions", value: c.unknown });
    }
    return {
      ...r,
      tech_stack: uniq(r.tech_stack.map(canonicalTech).filter((t): t is string => t !== null)),
      remote_regions: uniq(codes),
      timezones: uniq(timezones.map((t) => t.trim()).filter(Boolean)),
      locations: uniq(r.locations.map(canonicalLocation), (l) => `${l.city}|${l.region}|${l.country_code}`),
      salary: r.salary ? { ...r.salary, currency: r.salary.currency?.toUpperCase() ?? null } : null,
    };
  });
  return { roles: out, warnings };
}
