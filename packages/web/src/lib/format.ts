/** The three routing families the gateway exposes as forwarding endpoints. */
export type Fmt = "openai" | "anthropic" | "responses";

/** App-wide color language for the routing families — one hue per family so the
 *  same model / provider / format reads as the same color everywhere it appears
 *  (Models grouping panels, Connect base-URL + snippet cards, Logs format tag):
 *
 *    openai → emerald   ·   anthropic → amber   ·   responses → violet
 *
 *  This is the "data" palette; the structural palette is the brand `primary`
 *  (card-title icons). Each value is a set of Tailwind class fragments, paired
 *  light + dark so it reads in both themes. */
export const FMT_ACCENT: Record<
  Fmt,
  {
    solid: string; // dot / stripe / marker
    text: string; // label text
    soft: string; // faint fill for tinted cards
    border: string; // tinted card border
    chip: string; // count chip (bg + text)
    badge: string; // <Badge> override (replaces outline styling)
  }
> = {
  openai: {
    solid: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    soft: "bg-emerald-500/5",
    border: "border-emerald-500/30",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    badge: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  anthropic: {
    solid: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    soft: "bg-amber-500/5",
    border: "border-amber-500/30",
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    badge: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  responses: {
    solid: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-400",
    soft: "bg-violet-500/5",
    border: "border-violet-500/30",
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    badge: "border-transparent bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
};

/** Distinct hues for provider/source tags — deterministically assigned per
 *  provider id so the same source is always the same color. Deliberately
 *  disjoint from the format hues (emerald/amber/violet) so a source tag is
 *  never mistaken for a format tag. */
const PROVIDER_HUES: { solid: string; badge: string }[] = [
  { solid: "bg-sky-500", badge: "border-transparent bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  { solid: "bg-indigo-500", badge: "border-transparent bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" },
  { solid: "bg-fuchsia-500", badge: "border-transparent bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400" },
  { solid: "bg-rose-500", badge: "border-transparent bg-rose-500/15 text-rose-600 dark:text-rose-400" },
  { solid: "bg-teal-500", badge: "border-transparent bg-teal-500/15 text-teal-600 dark:text-teal-400" },
  { solid: "bg-orange-500", badge: "border-transparent bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  { solid: "bg-cyan-500", badge: "border-transparent bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  { solid: "bg-pink-500", badge: "border-transparent bg-pink-500/15 text-pink-600 dark:text-pink-400" },
];

/** Stable palette entry for a provider id (djb2 hash → one of PROVIDER_HUES).
 *  Same id always maps to the same color, across reloads and across the page. */
export function providerColor(id: string): { solid: string; badge: string } {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = (h * 33) ^ id.charCodeAt(i);
  return PROVIDER_HUES[Math.abs(h) % PROVIDER_HUES.length];
}
