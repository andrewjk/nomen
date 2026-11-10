import type { PageEndPoint } from "@torpor/build";

import component from "@/views/HomePage.torp";

const TITLE = "Nomen";
const DESCRIPTION = "The Nomen programming language.";

/** The site index. A placeholder until the real landing page exists. */
export default {
	component,
	head: (event) => [
		{ title: TITLE },
		{ name: "description", content: DESCRIPTION },
		{ property: "og:title", content: TITLE },
		{ property: "og:description", content: DESCRIPTION },
		{ property: "og:type", content: "website" },
		{ property: "og:url", content: event.url.href },
	],
} satisfies PageEndPoint;
