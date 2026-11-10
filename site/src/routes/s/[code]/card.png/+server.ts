import type { ServerEndPoint } from "@torpor/build";

import { render_code_card } from "../../../../lib/card.ts";
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

		let cache: Cache | undefined;
		try {
			cache = (globalThis as CachesGlobal).caches?.default;
		} catch {
			cache = undefined;
		}
		const hit = await cache?.match(event.request).catch(() => undefined);
		if (hit) return hit;

		try {
			const png = await render_code_card(source, event.url.host);
			const response = new Response(png, {
				headers: {
					"content-type": "image/png",
					"cache-control": "public, max-age=31536000, immutable",
				},
			});
			const ctx = (globalThis as Adapter).adapter?.ctx;
			if (cache && ctx) {
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
