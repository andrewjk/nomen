import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// 057: In Zig, you can use union(enum) to infer the tag type.
// In Echo, enums with associated data already ARE tagged unions —
// no separate enum declaration needed.
// The fix: the error version references a deleted type InsectStat.
// The fixed version uses the Insect enum directly.

test("ziglings 057 unions3 -- errors", () => {
	const input = `
import System

func printInsect = (int insect) {
    Console.write("??\\n")
}

pub func main = () {
    var int ant = InsectStat.still_alive
    printInsect(ant)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 057 unions3 -- fixed", () => {
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
    var Insect bee = Insect.flowers_visited(17)
    Console.write("Insect report! ")
    printInsect(ant)
    printInsect(bee)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 057 unions3 -- build", async () => {
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
    var Insect bee = Insect.flowers_visited(17)
    Console.write("Insect report! ")
    printInsect(ant)
    printInsect(bee)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64(
		"057",
		built,
		"Insect report! Ant alive is: true. Bee visited 17 flowers. \n",
	);
});
