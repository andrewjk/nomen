import type { PageServerEndPoint } from "@torpor/build";

/**
 * X's player card frames `/embed` directly; allow only X/Twitter to do so.
 * (Declared on the route rather than `site.middleware` so the global config's
 * Node-only imports never reach the Worker bundle.)
 */
export default {
	middleware: [
		{
			enter: (event) => {
				event.headers.set(
					"content-security-policy",
					"frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com",
				);
			},
		},
	],
} satisfies PageServerEndPoint;
