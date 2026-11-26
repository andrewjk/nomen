/**
 * Page titles, shared by each page's view and its endpoint. The view sets the
 * `<title>` in its `@head` block, because Torp applies an endpoint's `head`
 * only to the server render: a client-side navigation would otherwise keep
 * the previous page's title. Endpoints still use these for `og:title` and
 * `twitter:title`, which only crawlers read.
 */
export const TITLES = {
	home: "Nomen",
	readme: "Nomen — README",
	spec: "Nomen Language Specification",
	playground: "Nomen Playground",
	share_preview: "Share preview",
} as const;
