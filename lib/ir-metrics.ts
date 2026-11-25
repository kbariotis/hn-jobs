/**
 * Binary-relevance IR metrics. `totalRelevant` can exceed the relevant ids present in the
 * index (relevant gold roles the extractor missed are unretrievable and still count).
 */
export function ndcgAt(ranked: string[], relevant: Set<string>, totalRelevant: number, k = 10): number {
  if (totalRelevant === 0) return ranked.length === 0 ? 1 : 0;
  const dcg = ranked.slice(0, k).reduce((s, id, i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, totalRelevant); i++) idcg += 1 / Math.log2(i + 2);
  return dcg / idcg;
}

export function precisionAt(ranked: string[], relevant: Set<string>, k = 10): number {
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / k;
}

/** Precision at rank R = recall at rank R, where R = number of relevant items. */
export function rPrecision(ranked: string[], relevant: Set<string>, totalRelevant: number): number {
  if (totalRelevant === 0) return ranked.length === 0 ? 1 : 0;
  return ranked.slice(0, totalRelevant).filter((id) => relevant.has(id)).length / totalRelevant;
}
