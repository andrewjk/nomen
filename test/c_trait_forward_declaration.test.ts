import { expect, test } from "vite-plus/test";

import build from "../src/build";
import parse_raw from "./parse_with_imports";

// A trait declared inside a switch/match case body lives under the case list
// (plain `{ condition, branch }` wrapper objects). It must still be gathered
// and built like any other trait — its opaque-struct forward declaration
// (`struct Speaker;`) lands in the C headers and the emitted C compiles.

test("a trait declared inside a switch case still gets a C forward declaration", () => {
	const parsed = parse_raw(`
pub func main = () {
	switch {
		case true {
			trait Speaker { func speak = (self, out string) }
		}
	}
}
`);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "c" });
	expect(result.headers).toContain("struct Speaker;");
});

test("a trait declared inside a match case still gets a C forward declaration", () => {
	const parsed = parse_raw(`
pub func main = () {
	const x = 1
	match x {
		case 1 {
			trait Speaker { func speak = (self, out string) }
		}
		else {}
	}
}
`);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "c" });
	expect(result.headers).toContain("struct Speaker;");
});
