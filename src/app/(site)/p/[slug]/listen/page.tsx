import { articleRoute } from '../_lib/article-route';

// Deep link to the Listen view (/p/<slug>/listen): the article page with Listen open on load.

export const dynamic = 'force-dynamic';

const route = articleRoute('listen');
export const generateMetadata = route.generateMetadata;
export default route.Page;
