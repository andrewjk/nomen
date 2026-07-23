import { expect, test } from "vite-plus/test";
// TODO: The original Zig exercise uses @intFromEnum with {x:0>6} hex formatting
// to print HTML like <span style="color: #ff0000">Red</span>. Nomen has neither
// @intFromEnum nor hex formatting, so we print the hex color codes directly
// per enum variant instead. The exercise still tests enum exhaustiveness.

import build_and_check_output from "../build_and_check_output";
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
    const colors = Array(Color.red, Color.green, Color.blue)
    for color of colors {
        match color {
            case .red -> Console.write("#ff0000\\n")
            case .green -> Console.write("#00ff00\\n")
            case .??? -> Console.write("#0000ff\\n")
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
    const colors = Array(Color.red, Color.green, Color.blue)
    for color of colors {
        match color {
            case .red -> Console.write("#ff0000\\n")
            case .green -> Console.write("#00ff00\\n")
            case .blue -> Console.write("#0000ff\\n")
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
    const colors = Array(Color.red, Color.green, Color.blue)
    for color of colors {
        match color {
            case .red -> Console.write("#ff0000\\n")
            case .green -> Console.write("#00ff00\\n")
            case .blue -> Console.write("#0000ff\\n")
        }
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_036", "#ff0000\n#00ff00\n#0000ff\n", true);
});
