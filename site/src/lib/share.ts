/**
 * Share links put the whole program in the URL (base64url over UTF-8), so a
 * link is self-contained: the REPL decodes it, and the card image is derived
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

/** The share URL for a program (on the given origin). */
export function share_url(origin: string, source: string): string {
	return `${origin}/s/${encode_source(source)}`;
}

/** Codes longer than this would make unwieldy share links; the REPL refuses
 *  to share them. */
export const MAX_SHARE_SOURCE = 2_000;
