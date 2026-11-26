import type { PageEndPoint } from "@torpor/build";

import { TITLES } from "@/lib/titles.ts";
import component from "@/views/SpecPage.torp";

const TITLE = TITLES.spec;
const DESCRIPTION =
	"The Nomen language specification: syntax, types, memory management, concurrency, and the System library.";

/** SPEC.md, rendered at build time (see scripts/render-docs.ts). */
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
