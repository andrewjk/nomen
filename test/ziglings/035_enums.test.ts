import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 035 enums -- errors", () => {
	const input = `
import System

enum Ops {
  case ???
}

pub func main = () {
    const ops = Array(Ops.inc, Ops.inc, Ops.inc, Ops.pow, Ops.dec, Ops.dec)
    var current_value = 0

    for op of ops {
        match op {
            case .inc {
                current_value += 1
            }
            case .dec {
                current_value -= 1
            }
            case .pow {
                current_value *= current_value
            }
        }

        Console.write("\\{current_value} ")
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 035 enums -- fixed", () => {
	const input = `
import System

enum Ops {
  case inc
  case dec
  case pow
}

pub func main = () {
    const ops = Array(Ops.inc, Ops.inc, Ops.inc, Ops.pow, Ops.dec, Ops.dec)
    var current_value = 0

    for op of ops {
        match op {
            case .inc {
                current_value += 1
            }
            case .dec {
                current_value -= 1
            }
            case .pow {
                current_value *= current_value
            }
        }

        Console.write("\\{current_value} ")
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 035 enums -- build", async () => {
	const input = `
import System

enum Ops {
  case inc
  case dec
  case pow
}

pub func main = () {
    const ops = Array(Ops.inc, Ops.inc, Ops.inc, Ops.pow, Ops.dec, Ops.dec)
    var current_value = 0

    for op of ops {
        match op {
            case .inc {
                current_value += 1
            }
            case .dec {
                current_value -= 1
            }
            case .pow {
                current_value *= current_value
            }
        }

        Console.write("\\{current_value} ")
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_035", "1 2 3 9 8 7 \n", true);
});
