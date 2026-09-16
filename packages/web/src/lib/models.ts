import type { ProviderPublic } from "@/api";

/** A source's full known upstream list: discovery results + manual supplements,
 *  deduped and sorted case-insensitively for scanning. The ONE definition of
 *  "what can this source run" — the editor's upstream suggestions, the models
 *  page's staleness check, the source-test picker and the discovery-badge
 *  count all read this union. */
export function providerModelList(p?: Pick<ProviderPublic, "discoveredModels" | "extraModels"> | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...(p?.discoveredModels ?? []), ...(p?.extraModels ?? [])]) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Abbreviations for the sampling keys, used by the compact chain pills. */
const SAMPLING_ABBREV: Record<string, string> = {
  temperature: "t",
  top_p: "p",
  top_k: "k",
  presence_penalty: "pp",
  frequency_penalty: "fp",
  seed: "s",
};

/** Compact one-line summary of a slot's sampling defaults for the chain pills:
 *  abbreviated key=value pairs, e.g. "t0.2 p0.9 s42". "" when nothing is set. */
export function samplingSummary(s?: Record<string, unknown> | null): string {
  if (!s) return "";
  return Object.entries(s)
    .map(([k, v]) => `${SAMPLING_ABBREV[k] ?? k}${v}`)
    .join(" ");
}

/** Full-key k=v summary for detail rows (log/debug expanded views), e.g.
 *  "temperature=0.2 seed=42". "" when nothing is set. */
export function samplingPairs(s?: Record<string, unknown> | null): string {
  if (!s) return "";
  return Object.entries(s)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}
