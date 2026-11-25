CREATE EXTENSION IF NOT EXISTS vector;

-- One row per extracted role. Stable id `${posting_id}-${role_index}` makes re-indexing an upsert.
CREATE TABLE roles (
  role_id          text PRIMARY KEY,
  posting_id       bigint NOT NULL,
  role_index       int NOT NULL,
  thread_id        bigint NOT NULL,
  posted_at        timestamptz NOT NULL,
  extract_model    text NOT NULL,
  prompt_version   text NOT NULL,

  company_name     text,
  role_title       text,
  employment_type  text,
  remote_policy    text,
  seniority        text,
  remote_regions   text[] NOT NULL DEFAULT '{}',
  timezones        text[] NOT NULL DEFAULT '{}',
  countries        text[] NOT NULL DEFAULT '{}', -- from locations, for filtering
  cities           text[] NOT NULL DEFAULT '{}',
  tech_stack       text[] NOT NULL DEFAULT '{}',
  salary_min       numeric,
  salary_max       numeric,
  salary_currency  text,
  salary_period    text,
  visa_sponsorship boolean,
  apply_url        text,
  apply_email      text,

  data             jsonb NOT NULL, -- full Role as extracted
  doc              text NOT NULL,  -- the text that gets embedded
  tsv              tsvector GENERATED ALWAYS AS (to_tsvector('english', doc)) STORED,
  UNIQUE (posting_id, role_index)
);

CREATE INDEX roles_thread_idx  ON roles (thread_id);
CREATE INDEX roles_tech_idx    ON roles USING gin (tech_stack);
CREATE INDEX roles_regions_idx ON roles USING gin (remote_regions);
CREATE INDEX roles_country_idx ON roles USING gin (countries);
CREATE INDEX roles_tsv_idx     ON roles USING gin (tsv);

-- Embeddings keyed by model so several embedding models can be compared on the same rows.
-- Untyped `vector`: dimensions vary by model. No ANN index yet; exact scan is ms at this size.
CREATE TABLE role_embeddings (
  role_id     text NOT NULL REFERENCES roles ON DELETE CASCADE,
  embed_model text NOT NULL,
  doc_hash    text NOT NULL, -- skip re-embedding when the doc text is unchanged
  embedding   vector NOT NULL,
  PRIMARY KEY (role_id, embed_model)
);
