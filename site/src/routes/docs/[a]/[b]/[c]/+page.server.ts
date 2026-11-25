import type { PageServerEndPoint } from "@torpor/build";

import { api_endpoint } from "@/lib/api-server.ts";

/** The API pages at /docs/[a]/[b]/[c] (see src/lib/api-server.ts). */
export default api_endpoint<"/docs/[a]/[b]/[c]">(
	3,
) satisfies PageServerEndPoint<"/docs/[a]/[b]/[c]">;
