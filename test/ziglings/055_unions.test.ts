import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// 055: Zig plain unions store different types at the same address. Nomen enums
// with associated data are tagged unions (always track the active case), so the
// manual AntOrBee tracking from the Zig version is unnecessary.
// The fix: change `AntOrBee.c` to `AntOrBee.a` and `AntOrBee.b`.

test("ziglings 055 unions -- errors", () => {
	const input = `
import System

enum Insect {
    case flowers_visited(int count)
    case still_alive(bool alive)
}

pub func main = () {
    var Insect ant = Insect.flowers_visited(99)
    var int x = ant.alive
    Console.write("\\{x}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 055 unions -- fixed", () => {
	const input = `
import System

enum Insect {
    case flowers_visited(int count)
    case still_alive(bool alive)
}

func printInsect = (Insect insect, bool is_ant) {
    if is_ant {
        Console.write("Ant alive is: \\{insect.alive}. ")
    } else {
        Console.write("Bee visited \\{insect.count} flowers. ")
    }
}

pub func main = () {
    var Insect ant = Insect.still_alive(true)
    var Insect bee = Insect.flowers_visited(15)
    Console.write("Insect report! ")
    printInsect(ant, true)
    printInsect(bee, false)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 055 unions -- build", async () => {
	const input = `
import System

enum Insect {
    case flowers_visited(int count)
    case still_alive(bool alive)
}

func printInsect = (Insect insect, bool is_ant) {
    if is_ant {
        Console.write("Ant alive is: \\{insect.alive}. ")
    } else {
        Console.write("Bee visited \\{insect.count} flowers. ")
    }
}

pub func main = () {
    var Insect ant = Insect.still_alive(true)
    var Insect bee = Insect.flowers_visited(15)
    Console.write("Insect report! ")
    printInsect(ant, true)
    printInsect(bee, false)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64(
		"055",
		built,
		"Insect report! Ant alive is: true. Bee visited 15 flowers. \n",
	);
});
