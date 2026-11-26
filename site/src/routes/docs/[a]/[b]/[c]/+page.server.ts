import type { PageServerEndPoint } from "@torpor/build";

import { api_endpoint } from "@/lib/api-server.ts";

const endpoint = api_endpoint<"/docs/[a]/[b]/[c]">(3);

/** The API pages at /docs/[a]/[b]/[c] (see src/lib/api-server.ts). `load` is spelled
 *  out because Torp finds a page's server load by reading this file: without
 *  it, client-side navigation never fetches the page data. */
export default {
	prerender: endpoint.prerender,
	load: endpoint.load,
} satisfies PageServerEndPoint<"/docs/[a]/[b]/[c]">;
