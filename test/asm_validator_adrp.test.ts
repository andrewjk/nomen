import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";

/**
 * asm validator vs the backend's own adrp/@PAGE vtable loads (pre-existing):
 * any build that defines a trait-conforming struct emits the vtable pointer
 * install in its init:
 *
 *   adrp x9, _<T>_traits@PAGE
 *   add  x9, x9, _<T>_traits@PAGEOFF
 *
 * The validator's mnemonic table knew neither `adrp` nor the `@PAGE`/
 * `@PAGEOFF` relocation operand forms, so `build(..., { arch: "aarch64" })`
 * returned asm errors for perfectly valid code (clang assembles it fine).
 */

const SRC = `
import System

trait Area {
	func area = (self, out float)
}

struct Circle : Area {
	var float r
	func area = (self, out float) {
		return 3.0 * self.r * self.r
	}
}

pub func main = () {
	var Circle c = Circle(2.0)
	Console.write("\\{c.area()}\\n")
}
`;

describe("asm validator accepts the backend's adrp/@PAGEOFF vtable loads", () => {
	test("trait-conforming struct builds with no asm errors", () => {
		const parsed = parse_raw(SRC);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		// The vtable install really is in the output (the shape we validate).
		expect(result.code).toContain("adrp x9, _Circle_traits@PAGE");
		expect(result.code).toContain("add x9, x9, _Circle_traits@PAGEOFF");
	});
});
