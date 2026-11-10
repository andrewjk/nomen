import type { ServerEndPoint } from "@torpor/build";

import { type CardEnv, render_code_card } from "../../../../lib/card_browser.ts";
import { decode_source } from "../../../../lib/share.ts";

type CachesGlobal = { caches?: { default?: Cache } };
type Adapter = { adapter?: { ctx?: { waitUntil(p: Promise<unknown>): void } } };

/**
 * The per-program social card. The URL contains the program, so the image is
 * content-addressed and can be cached forever.
 *
 * The Cache API is unavailable on workers.dev; there (and on any cache error)
 * the card is simply rendered for every request rather than failing.
 */
export default {
	get: async (event) => {
		const source = decode_source(event.params.code);
		if (source === undefined) return Response.redirect(new URL("/og.png", event.url), 302);
		const output = decode_source(event.url.searchParams.get("out") ?? undefined);

		let cache: Cache | undefined;
		try {
			cache = (globalThis as CachesGlobal).caches?.default;
		} catch {
			cache = undefined;
		}
		const hit = await cache?.match(event.request).catch(() => undefined);
		if (hit) return hit;

		try {
			const env = (globalThis as { adapter?: { env?: CardEnv } }).adapter?.env;
			const { png, fallback } = await render_code_card(
				env,
				event.url,
				source,
				output,
				event.url.host,
			);
			const response = new Response(png, {
				headers: {
					"content-type": "image/png",
					// A browser failure could be transient: let a fallback card be
					// replaced (and retried) instead of caching it forever.
					"cache-control": fallback ? "public, max-age=60" : "public, max-age=31536000, immutable",
				},
			});
			const ctx = (globalThis as Adapter).adapter?.ctx;
			if (cache && ctx && !fallback) {
				ctx.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
			}
			return response;
		} catch (error) {
			console.error("share card render failed:", error);
			// X follows redirects; fall back to the generic site card.
			return Response.redirect(new URL("/og.png", event.url), 302);
		}
	},
} satisfies ServerEndPoint<"/s/[code]/card.png">;
