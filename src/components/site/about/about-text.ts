// About texts → paragraphs (pure, isomorphic). The same split as `siteViewModelFrom`
// (src/lib/view-models.ts): blank lines separate paragraphs, inner whitespace collapses.

export function aboutParagraphs(bodyMd: string): string[] {
  return bodyMd
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
