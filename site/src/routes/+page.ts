import type { PageEndPoint } from "@torpor/build";

import component from "@/views/ReplPage.torp";

const TITLE = "Nomen REPL";
const DESCRIPTION =
	"Write and run Nomen programs in your browser: structs, enums, traits, generics, and the System library, compiled by the JavaScript backend.";

export default {
	component,
	// Link unfurls (Twitter/X, Slack, Discord, …) get the title, description,
	// and a screenshot of the real REPL. The head elements are written out
	// rather than using `seo()` so no server-only framework code is imported
	// into the Worker.
	head: (event) => [
		{ title: TITLE },
		{ name: "description", content: DESCRIPTION },
		{ property: "og:title", content: TITLE },
		{ property: "og:description", content: DESCRIPTION },
		{ property: "og:type", content: "website" },
		{ property: "og:image", content: `${event.url.origin}/og.png` },
		{ property: "og:url", content: event.url.href },
		{ name: "twitter:card", content: "summary_large_image" },
		{ name: "twitter:title", content: TITLE },
		{ name: "twitter:description", content: DESCRIPTION },
		{ name: "twitter:image", content: `${event.url.origin}/og.png` },
	],
} satisfies PageEndPoint;
