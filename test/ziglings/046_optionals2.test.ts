import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise uses a linked list of Elephant structs with
// nullable pointer tails and `orelse break` for loop control.
// Echo uses `ref Elephant?` for nullable refs, `if ... == null { break }`
// instead of `orelse break`, and ref params instead of raw pointers.

test("ziglings 046 optionals2 -- errors", () => {
	const input = `
import System

struct Elephant {
    var char letter
    var ref Elephant? tail = null
    var bool visited = false
}

pub func main = () {
    var Elephant elephantA = Elephant('A')
    var Elephant elephantB = Elephant('B')
    var Elephant elephantC = Elephant('C')

    elephantA.tail = elephantB
    elephantB.tail = elephantC

    var ref Elephant current = ref elephantA
    while !current.visited {
        Console.write("Elephant \\{current.letter}. ")
        current.visited = true
        if current.tail == null { break }
        current = current.tail
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 046 optionals2 -- fixed", () => {
	const input = `
import System

struct Elephant {
    var char letter
    var ref Elephant? tail = null
    var bool visited = false
}

func visitElephants = (ref Elephant current) {
    while !current.visited {
        Console.write("Elephant \\{current.letter}. ")
        current.visited = true
        if current.tail == null { break }
        current = current.tail
    }
}

pub func main = () {
    var Elephant elephantA = Elephant('A')
    var Elephant elephantB = Elephant('B')
    var Elephant elephantC = Elephant('C')

    elephantA.tail = elephantB
    elephantB.tail = elephantC

    visitElephants(ref elephantA)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 046 optionals2 -- build", async () => {
	const input = `
import System

struct Elephant {
    var char letter
    var ref Elephant? tail = null
    var bool visited = false
}

func visitElephants = (ref Elephant current) {
    while !current.visited {
        Console.write("Elephant \\{current.letter}. ")
        current.visited = true
        if current.tail == null { break }
        current = current.tail
    }
}

pub func main = () {
    var Elephant elephantA = Elephant('A')
    var Elephant elephantB = Elephant('B')
    var Elephant elephantC = Elephant('C')

    elephantA.tail = elephantB
    elephantB.tail = elephantC

    visitElephants(ref elephantA)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("046", built, "Elephant A. Elephant B. Elephant C. \n");
});
