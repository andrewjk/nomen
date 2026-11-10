import type { PageEndPoint } from "@torpor/build";

import component from "@/views/EmbedPage.torp";

const TITLE = "Nomen Playground";
const DESCRIPTION =
	"Write and run Nomen programs inside this post: structs, enums, traits, and the System library.";

/**
 * The player-card page. X renders this in an iframe at 640x480 when the
 * domain is approved for Player Cards (see site/README.md); without approval
 * the link shows as a plain link. The `frame-ancestors` header that lets X
 * frame it is set in site.config.ts.
 */
export default {
	component,
	head: (event) => {
		const origin = event.url.origin;
		return [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ name: "twitter:card", content: "player" },
			{ name: "twitter:site", content: "@andrewjk" },
			{ name: "twitter:title", content: TITLE },
			{ name: "twitter:description", content: DESCRIPTION },
			{ name: "twitter:player", content: `${origin}/embed` },
			{ name: "twitter:player:width", content: "640" },
			{ name: "twitter:player:height", content: "480" },
			{ name: "twitter:image", content: `${origin}/card.png` },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
			{ property: "og:image", content: `${origin}/card.png` },
			{ property: "og:url", content: event.url.href },
		];
	},
} satisfies PageEndPoint;
