import { serializeJsonLd } from '@/server/public/seo';

// Structured data (Stage A — spec/ui.md §3; spec/architecture.md §6): one
// `<script type="application/ld+json">` carrying the request's CSP nonce, its body escaped by
// serializeJsonLd so author text can never close the element. Server component.

export function JsonLd({ data, nonce }: { data: Record<string, unknown>; nonce?: string }) {
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
