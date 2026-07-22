import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: pattern matching", () => {
	test("match on enum with associated data, binding the payload", () => {
		const input = `
pub enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}

const shape = Shape.rect(10, 20)
const message = match shape {
    case .circle(r) -> "radius \\{r}"
    case .rect(w, h) -> "\\{w}x\\{h}"
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: bitsets", () => {
	test("declare, combine, mask, and toggle flags", () => {
		const input = `
pub bitset Permissions {
    case read
    case write
    case execute
}

var flags = Permissions.read | Permissions.write
const can_write = (flags & Permissions.write) == Permissions.write
flags = flags ^ Permissions.execute
`;
		expect(compile_module(input)).toEqual([]);
	});
});
