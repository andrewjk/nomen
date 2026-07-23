import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

test("ziglings 032 unreachable -- errors", () => {
	const input = `
import System

pub func main = () {
    const operations = Array(1, 1, 1, 3, 2, 2)
    var current_value = 0

    for op of operations {
        match op {
            case 1 {
                current_value += 1
            }
            case 2 {
                current_value -= 1
            }
            case 3 {
                current_value *= current_value
            }
            else {
                panic(???)
            }
        }

        Console.write("\\{current_value} ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 032 unreachable -- fixed", () => {
	const input = `
import System

pub func main = () {
    const operations = Array(1, 1, 1, 3, 2, 2)
    var current_value = 0

    for op of operations {
        match op {
            case 1 {
                current_value += 1
            }
            case 2 {
                current_value -= 1
            }
            case 3 {
                current_value *= current_value
            }
            else {
                panic("unreachable")
            }
        }

        Console.write("\\{current_value} ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 032 unreachable -- build", async () => {
	const input = `
import System

pub func main = () {
    const operations = Array(1, 1, 1, 3, 2, 2)
    var current_value = 0

    for op of operations {
        match op {
            case 1 {
                current_value += 1
            }
            case 2 {
                current_value -= 1
            }
            case 3 {
                current_value *= current_value
            }
            else {
                Console.write("unreachable")
            }
        }

        Console.write("\\{current_value} ")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_032", "1 2 3 9 8 7 ", true);
});
