import type { PageEndPoint } from "@torpor/build";
import { ok } from "@torpor/build/response";

import component from "@/views/SharePreviewPage.torp";

import { decode_source } from "../../../lib/share.ts";

/**
 * Shows the social card a share link generates. The playground's
 * "Preview share" link carries the current program (and run output) here as
 * `?code=` / `?out=`; the card itself is the ordinary `/s/<code>/card.png`
 * route, so this page is just an image preview.
 */
export default {
	component,
	load: (event) => {
		const code = event.url.searchParams.get("code") ?? "";
		if (decode_source(code) === undefined) return ok({});
		const out = event.url.searchParams.get("out") ?? "";
		return ok({ code, out: decode_source(out) !== undefined ? out : "" });
	},
	head: () => [
		{ title: "Share preview" },
		{
			name: "description",
			content: "Preview of the social card for a shared Nomen program.",
		},
	],
} satisfies PageEndPoint<"/playground/preview">;
