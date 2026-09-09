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
