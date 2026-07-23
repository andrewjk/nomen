import { expect, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// 056: Zig tagged unions use switch to capture the active field's value.
// In Nomen, enums with associated data are tagged unions, and match with
// payload field access gives us the same thing.
// The fix: pass ant/bee to printInsect, match on insect and use the
// captured values via field access.

test("ziglings 056 unions2 -- errors", () => {
	const input = `
import System

enum Insect {
    case flowers_visited(int count)
    case still_alive(bool alive)
}

func printInsect = (Insect insect) {
    match insect {
        case Insect.still_alive {
            Console.write("Ant alive is: \\{insect.alive}. ")
        }
        case Insect.flowers_visited {
            Console.write("Bee visited \\{insect.count} flowers. ")
        }
    }
}

pub func main = () {
    var Insect ant = Insect.still_alive(true)
    var Insect bee = Insect.flowers_visited(16)
    Console.write("Insect report! ")
    printInsect(???)
    printInsect(???)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 056 unions2 -- fixed", () => {
	const input = `
import System

enum Insect {
    case flowers_visited(int count)
    case still_alive(bool alive)
}

func printInsect = (Insect insect) {
    match insect {
        case Insect.still_alive {
            Console.write("Ant alive is: \\{insect.alive}. ")
        }
        case Insect.flowers_visited {
            Console.write("Bee visited \\{insect.count} flowers. ")
        }
    }
}

pub func main = () {
    var Insect ant = Insect.still_alive(true)
    var Insect bee = Insect.flowers_visited(16)
    Console.write("Insect report! ")
    printInsect(ant)
    printInsect(bee)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 056 unions2 -- build", async () => {
	const input = `
import System

enum Insect {
    case flowers_visited(int count)
    case still_alive(bool alive)
}

func printInsect = (Insect insect) {
    match insect {
        case Insect.still_alive {
            Console.write("Ant alive is: \\{insect.alive}. ")
        }
        case Insect.flowers_visited {
            Console.write("Bee visited \\{insect.count} flowers. ")
        }
    }
}

pub func main = () {
    var Insect ant = Insect.still_alive(true)
    var Insect bee = Insect.flowers_visited(16)
    Console.write("Insect report! ")
    printInsect(ant)
    printInsect(bee)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(
		input,
		"056",
		"Insect report! Ant alive is: true. Bee visited 16 flowers. \n",
		true,
	);
});
