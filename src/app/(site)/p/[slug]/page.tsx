import { articleRoute } from './_lib/article-route';

// Public article, Read view (spec/ui.md §3 "Article").

export const dynamic = 'force-dynamic';

const route = articleRoute('read');
export const generateMetadata = route.generateMetadata;
export default route.Page;
