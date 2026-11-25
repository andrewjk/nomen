import type { PageEndPoint } from "@torpor/build";

import { api_head } from "@/lib/api.ts";
import component from "@/views/ApiPage.torp";

/** The System library API reference: every namespace and type. */
export default {
	component,
	head: (event) => api_head(event.url, event.data.page),
} satisfies PageEndPoint;
