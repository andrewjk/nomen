import type { PageServerEndPoint } from "@torpor/build";
import { ok } from "@torpor/build/response";

import pages from "@/lib/docs/api-pages.generated.ts";

/** The API reference index, rendered at build time (see scripts/render-api.ts). */
export default {
	prerender: true,
	load: () => ok({ page: pages[""] }),
} satisfies PageServerEndPoint;
