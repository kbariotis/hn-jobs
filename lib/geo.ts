/**
 * Geography shared by relevance predicates and SQL filters, so both mean the same thing by
 * "a job available in X". Codes follow LABELING.md (ISO alpha-2 + macro regions).
 */
const EUROPE = [
  "AT",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "RS",
  "SE",
  "SI",
  "SK",
  "UA",
  "AL",
  "BA",
  "ME",
  "MK",
  "MD",
];
const MIDDLE_EAST_AFRICA = ["AE", "EG", "IL", "KE", "MA", "MG", "NG", "SA", "TR", "ZA"];
const LATAM = ["AR", "BO", "BR", "CL", "CO", "CR", "EC", "GT", "MX", "PE", "PY", "UY", "VE"];
const APAC = ["AU", "CN", "HK", "ID", "IN", "JP", "KR", "MY", "NZ", "PH", "SG", "TH", "TW", "VN"];
const NORTH_AMERICA = ["US", "CA"];

const MEMBERS: Record<string, string[]> = {
  EUROPE,
  EMEA: [...EUROPE, ...MIDDLE_EAST_AFRICA],
  LATAM,
  APAC,
  AMERICAS: [...NORTH_AMERICA, ...LATAM],
};

/**
 * Countries whose offices satisfy a region (a country covers itself).
 * GLOBAL: none, since no office is "worldwide".
 */
export function countriesIn(code: string): string[] {
  if (code === "GLOBAL") {
    return [];
  }
  return MEMBERS[code] ?? [code];
}

/**
 * remote_regions values that make a remote role open to someone in `code`:
 * the code itself, every macro containing it, GLOBAL, and (for a macro) its member countries.
 * A remote role with no stated regions does NOT match a region query (LABELING.md: unstated).
 * "Worldwide" means explicitly open globally, so GLOBAL only matches GLOBAL.
 */
export function compatibleRemoteRegions(code: string): string[] {
  if (code === "GLOBAL") {
    return ["GLOBAL"];
  }
  const own = countriesIn(code);
  const macros = Object.entries(MEMBERS)
    .filter(([macro, cs]) => macro === code || own.some((c) => cs.includes(c)))
    .map(([macro]) => macro);
  return [...new Set([code, "GLOBAL", ...macros, ...own])];
}

/** Is a role available to someone in `code`? Remote and open there, or has an office there. */
export function availableIn(
  role: {
    remote_policy: string | null;
    remote_regions: string[];
    locations: { country_code: string | null }[];
  },
  code: string,
): boolean {
  const remoteOk = compatibleRemoteRegions(code);
  if (role.remote_policy === "remote" && role.remote_regions.some((r) => remoteOk.includes(r))) {
    return true;
  }
  const cs = countriesIn(code);
  return role.locations.some((l) => l.country_code !== null && cs.includes(l.country_code));
}
