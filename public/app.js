// Search page. All post-derived values are inserted with textContent / attributes only:
// never innerHTML, so content from HN posts can't inject markup or script.
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("search");
  const input = $("q");
  const status = $("status");
  const filtersEl = $("filters");
  const results = $("results");

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text != null) {
      n.textContent = text;
    }
    return n;
  };

  // Defence in depth: the server already restricts to http(s); check again before making a link.
  const httpUrl = (u) => {
    try {
      const url = new URL(u);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  };

  const link = (href, text) => {
    const a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    return a;
  };

  function renderFilters(f, degraded) {
    filtersEl.replaceChildren();
    if (degraded) {
      filtersEl.append(
        el(
          "span",
          "note",
          "Couldn't read filters from your query; showing closest matches by meaning.",
        ),
      );
      filtersEl.hidden = false;
      return;
    }
    const chips = [
      ...f.work_modes,
      ...f.regions.map((r) => `in ${r}`),
      ...f.cities,
      ...f.seniority,
      ...f.employment_types,
      ...f.tech_all,
      ...(f.tech_any.length ? [f.tech_any.join(" or ")] : []),
      ...(f.min_salary_usd_year ? [`≥ $${Math.round(f.min_salary_usd_year / 1000)}k`] : []),
      ...(f.visa_sponsorship ? ["visa sponsorship"] : []),
    ];
    if (!chips.length) {
      filtersEl.hidden = true;
      return;
    }
    filtersEl.append(el("span", "label", "Filtered by:"));
    for (const c of chips) {
      filtersEl.append(el("span", "chip", c));
    }
    filtersEl.hidden = false;
  }

  function renderResult(r) {
    const li = el("li", "card");
    const head = el("div", "head");
    head.append(el("h2", null, r.title || "Untitled role"), el("span", "company", r.company || ""));
    li.append(head);

    const where = [
      r.remote_policy,
      r.remote_regions.length ? r.remote_regions.join(", ") : null,
      r.locations.join(" · ") || null,
    ]
      .filter(Boolean)
      .join(" — ");
    const meta = el("p", "meta");
    for (const part of [where, r.seniority, r.employment_type, r.salary].filter(Boolean)) {
      meta.append(el("span", null, part));
    }
    li.append(meta);

    if (r.tech.length) {
      const tech = el("p", "tech");
      for (const t of r.tech) {
        tech.append(el("span", "tag", t));
      }
      li.append(tech);
    }

    const actions = el("p", "actions");
    const apply = r.apply_url && httpUrl(r.apply_url);
    if (apply) {
      actions.append(link(apply, "Apply"));
    } else if (r.apply_email) {
      const a = el("a", null, r.apply_email);
      a.href = `mailto:${encodeURIComponent(r.apply_email).replace("%40", "@")}`;
      actions.append(a);
    }
    actions.append(link(r.hn_url, "HN post"));
    li.append(actions);
    return li;
  }

  async function run(q) {
    status.textContent = "Searching…";
    results.replaceChildren();
    filtersEl.hidden = true;
    const url = new URL("/api/search", location.origin);
    url.searchParams.set("q", q);
    history.replaceState(null, "", `?q=${encodeURIComponent(q)}`);
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) {
        status.textContent = body.error || "Search failed.";
        return;
      }
      renderFilters(body.filters, body.degraded);
      status.textContent = body.results.length
        ? `${body.results.length} roles`
        : "No matching roles this month. Try loosening a constraint.";
      results.replaceChildren(...body.results.map(renderResult));
    } catch {
      status.textContent = "Network error. Please try again.";
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q.length >= 2) {
      run(q);
    }
  });
  $("examples").addEventListener("click", (e) => {
    const q = e.target.closest("button")?.dataset.q;
    if (q) {
      input.value = q;
      run(q);
    }
  });

  const initial = new URLSearchParams(location.search).get("q");
  if (initial) {
    input.value = initial.slice(0, 200);
    run(input.value);
  }
})();
