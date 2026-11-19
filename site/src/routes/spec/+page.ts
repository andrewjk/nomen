import type { PageEndPoint } from "@torpor/build";

import component from "@/views/SpecPage.torp";

const TITLE = "Nomen Language Specification";
const DESCRIPTION =
	"The Nomen language specification: syntax, types, memory management, concurrency, and the System library.";

/** SPEC.md, rendered at build time (see scripts/render-docs.ts). */
export default {
	component,
	prerender: true,
	head: (event) => [
		{ title: TITLE },
		{ name: "description", content: DESCRIPTION },
		{ property: "og:title", content: TITLE },
		{ property: "og:description", content: DESCRIPTION },
		{ property: "og:type", content: "website" },
		{ property: "og:url", content: event.url.href },
	],
} satisfies PageEndPoint;
