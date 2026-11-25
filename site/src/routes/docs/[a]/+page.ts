import type { PageEndPoint } from "@torpor/build";

import { api_head } from "@/lib/api.ts";
import component from "@/views/ApiPage.torp";

/** A namespace or type page of the API reference. */
export default {
	component,
	head: (event) => api_head(event.url, event.data.page),
} satisfies PageEndPoint<"/docs/[a]">;
