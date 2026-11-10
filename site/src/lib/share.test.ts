import { expect, test } from "vitest";

import {
	decode_source,
	encode_source,
	MAX_SHARE_OUTPUT,
	MAX_SHARE_SOURCE,
	preview_path,
	share_url,
} from "./share.ts";

test("round-trips a program through the URL payload", () => {
	const source = `struct Point {\n\tvar int x\n}\n\npub func main = () {\n\tConsole.write_line("héllo 🚀")\n}\n`;
	expect(decode_source(encode_source(source))).toEqual(source);
});

test("encodes url-safe base64 without padding", () => {
	const encoded = encode_source("a?b>c~d\u00ff");
	expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
	expect(encoded).not.toContain("=");
});

test("share links put the payload in the path", () => {
	expect(share_url("https://nomen.test", "pub func main = () {}")).toEqual(
		`https://nomen.test/s/${encode_source("pub func main = () {}")}`,
	);
});

test("a run output rides along in the query string", () => {
	const source = "pub func main = () {}";
	const output = "hello\n";
	expect(share_url("https://nomen.test", source, output)).toEqual(
		`https://nomen.test/s/${encode_source(source)}?out=${encode_source(output)}`,
	);
	expect(decode_source(encode_source(output))).toEqual(output);
});

test("the preview link carries the code and output", () => {
	const path = preview_path("pub func main = () {}", "hello\n");
	const url = new URL(path, "https://nomen.test");
	expect(url.pathname).toBe("/playground/preview");
	expect(decode_source(url.searchParams.get("code") ?? undefined)).toBe("pub func main = () {}");
	expect(decode_source(url.searchParams.get("out") ?? undefined)).toBe("hello\n");
	expect(preview_path("code")).not.toContain("out=");
});

test("missing or malformed payloads decode to undefined", () => {
	expect(decode_source(undefined)).toBeUndefined();
	expect(decode_source("")).toBeUndefined();
	expect(decode_source("not base64!")).toBeUndefined();
	expect(decode_source("a")).toBeUndefined();
});

test("the share limits leave room for a comfortable link", () => {
	expect(MAX_SHARE_SOURCE).toBeGreaterThan(0);
	expect(MAX_SHARE_OUTPUT).toBeGreaterThan(0);
	expect(encode_source("x".repeat(MAX_SHARE_SOURCE)).length).toBeLessThan(4096);
	expect(encode_source("x".repeat(MAX_SHARE_OUTPUT)).length).toBeLessThan(4096);
});
