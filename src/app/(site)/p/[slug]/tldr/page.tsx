import { articleRoute } from '../_lib/article-route';

// Deep link to the TLDR deck (/p/<slug>/tldr): the article page with the deck open on load.

export const dynamic = 'force-dynamic';

const route = articleRoute('tldr');
export const generateMetadata = route.generateMetadata;
export default route.Page;
