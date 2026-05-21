import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 036 enums2 -- errors", () => {
	const input = `
import System

enum Color {
  case red
  case green
  case ???
}

pub func main = () {
    const colors = [Color.red, Color.green, Color.blue]
    for color of colors {
        match color {
            case .red -> Console.write("red ")
            case .green -> Console.write("green ")
            case .??? -> Console.write("blue ")
        }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 036 enums2 -- fixed", () => {
	const input = `
import System

enum Color {
  case red
  case green
  case blue
}

pub func main = () {
    const colors = [Color.red, Color.green, Color.blue]
    for color of colors {
        match color {
            case .red -> Console.write("red ")
            case .green -> Console.write("green ")
            case .blue -> Console.write("blue ")
        }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 036 enums2 -- build", async () => {
	const input = `
import System

enum Color {
  case red
  case green
  case blue
}

pub func main = () {
    const colors = [Color.red, Color.green, Color.blue]
    for color of colors {
        match color {
            case .red -> Console.write("red ")
            case .green -> Console.write("green ")
            case .blue -> Console.write("blue ")
        }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("036", built, "red green blue ");
});
