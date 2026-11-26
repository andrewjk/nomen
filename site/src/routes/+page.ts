import type { PageEndPoint } from "@torpor/build";

import { TITLES } from "@/lib/titles.ts";
import component from "@/views/HomePage.torp";

const TITLE = TITLES.home;
const DESCRIPTION =
	"Nomen is a statically-typed, memory managed language that compiles to C, AArch64 assembly, and JavaScript.";

/** The site index: README's introduction and features, plus a sample program. */
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
