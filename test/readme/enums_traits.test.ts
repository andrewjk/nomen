import { describe, expect, test } from "vite-plus/test";

import { compile_main, compile_module } from "./_helpers.ts";

describe("readme: enums", () => {
	test("plain enum, enum with associated data, shorthand", () => {
		const input = `
pub enum Direction {
    case north
    case south
    case east
    case west
}

pub enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}

var Direction dir = .east
const shape = Shape.rect(10, 20)
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: traits", () => {
	test("trait with implementing struct assigned to trait type", () => {
		const input = `
pub trait Printable {
    func to_string = (self, out string)
}

pub struct Point : Printable {
    pub var int x
    pub var int y

    pub func to_string = (self, out string) {
        return "Point(\\{self.x}, \\{self.y})"
    }
}

const Printable p = Point(1, 2)
const s = p.to_string()
`;
		expect(compile_main(input)).toEqual([]);
	});
});
