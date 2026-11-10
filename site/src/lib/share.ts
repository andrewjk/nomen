/**
 * Share links put the whole program in the URL (base64url over UTF-8), so a
 * link is self-contained: the playground decodes it, and the card image is derived
 * from the same bytes.
 */

/** Encode a program as URL-safe base64 (no padding, `-`/`_` alphabet). */
export function encode_source(source: string): string {
	const bytes = new TextEncoder().encode(source);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a share-link payload; undefined for malformed input. */
export function decode_source(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

/** The share URL for a program (on the given origin). An optional run output
 *  rides along as `?out=`, so the card can show it without executing code
 *  server-side. */
export function share_url(origin: string, source: string, output = ""): string {
	const base = `${origin}/s/${encode_source(source)}`;
	return output ? `${base}?out=${encode_source(output)}` : base;
}

/** The path to the share-preview page for a program (relative, so it works
 *  on any origin). */
export function preview_path(source: string, output = ""): string {
	const params = new URLSearchParams({ code: encode_source(source) });
	if (output) params.set("out", encode_source(output));
	return `/playground/preview?${params}`;
}

/** Codes longer than this would make unwieldy share links; the playground
 *  refuses to share them. */
export const MAX_SHARE_SOURCE = 2_000;

/** Output longer than this is truncated in the share link (the card shows a
 *  handful of lines anyway). */
export const MAX_SHARE_OUTPUT = 2_000;
