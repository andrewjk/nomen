import type { PageServerEndPoint } from "@torpor/build";
import { notFound, ok } from "@torpor/build/response";

import pages from "./docs/api-pages.generated.ts";

/** The route params of each depth, outermost first: `/docs/[a]/[b]/[c]`. */
const KEYS = ["a", "b", "c"] as const;

/**
 * The server endpoint for the API pages `depth` segments below `/docs`
 * (`System` is 1, `System/List` 2, `System/Text/Json` 3). Torp's `[...path]`
 * splat can't carry a server endpoint, so each depth has its own route folder
 * and they all share this: the load serves the page's prerendered data, and
 * the prerender params are every generated page at that depth.
 */
export function api_endpoint<Route extends string>(depth: number): PageServerEndPoint<Route> {
	const keys = KEYS.slice(0, depth);
	return {
		prerender: {
			params: Object.keys(pages)
				.filter((path) => path !== "" && path.split("/").length === depth)
				.map((path) => {
					const parts = path.split("/");
					// The keys are Route's params by construction.
					return Object.fromEntries(keys.map((key, i) => [key, parts[i]])) as never;
				}),
		},
		load: (event) => {
			const params = event.params as Record<string, string>;
			const page = pages[keys.map((key) => params[key]).join("/")];
			return page ? ok({ page }) : notFound();
		},
	};
}
