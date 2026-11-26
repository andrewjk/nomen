import type { PageEndPoint } from "@torpor/build";

import { TITLES } from "@/lib/titles.ts";
import component from "@/views/ReadmePage.torp";

const TITLE = TITLES.readme;
const DESCRIPTION =
	"An overview of the Nomen programming language: installation, the CLI, and a tour of the language.";

/** README.md, rendered at build time (see scripts/render-docs.ts). */
export default {
	component,
	prerender: true,
	head: (event) => [
		{ name: "description", content: DESCRIPTION },
		{ property: "og:title", content: TITLE },
		{ property: "og:description", content: DESCRIPTION },
		{ property: "og:type", content: "website" },
		{ property: "og:url", content: event.url.href },
	],
} satisfies PageEndPoint;
