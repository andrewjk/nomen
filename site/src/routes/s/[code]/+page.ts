import type { PageEndPoint } from "@torpor/build";
import { ok } from "@torpor/build/response";

import component from "@/views/ReplPage.torp";

import { decode_source } from "../../../lib/share.ts";

const TITLE = "Nomen REPL";
const DESCRIPTION = "Open this Nomen program in the REPL and run it in your browser.";

/** A self-contained share link: the program is the URL. */
export default {
	component,
	load: (event) => {
		const source = decode_source(event.params.code);
		return ok(source !== undefined ? { source } : {});
	},
	head: (event) => {
		const origin = event.url.origin;
		const source = decode_source(event.params.code);
		const image =
			source !== undefined ? `${origin}/s/${event.params.code}/card.png` : `${origin}/og.png`;
		return [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
			{ property: "og:image", content: image },
			{ property: "og:url", content: event.url.href },
			{ name: "twitter:card", content: "summary_large_image" },
			{ name: "twitter:title", content: TITLE },
			{ name: "twitter:description", content: DESCRIPTION },
			{ name: "twitter:image", content: image },
		];
	},
} satisfies PageEndPoint<"/s/[code]">;
