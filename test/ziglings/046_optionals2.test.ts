import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise uses a linked list of Elephant structs with
// nullable pointer tails. Three steps:
//  -- errors: the original broken inline-traversal pattern (rejected).
//  -- fixed with safety checks: the original "fixed" helper-function pattern,
//     which used `ref Elephant?` fields. Those fields are now disallowed for
//     soundness (a non-owning borrow can outlive its target), so this step
//     asserts the safety check fires rather than silently compiling.
//  -- build: the current arena LinkedList version, which actually builds/runs.

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

test("ziglings 046 optionals2 -- fixed with safety checks", () => {
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
	// The `ref Elephant? tail` field is a non-owning borrow with no lifetime
	// enforcement; the safety check rejects it at compile time.
	expect(parsed.errors.some((e) => e.message.includes("fields cannot be 'ref'"))).toBe(true);
});

test("ziglings 046 optionals2 -- build", async () => {
	const input = `
import System

pub func main = () {
    var LinkedList<int> elephants = LinkedList<int>()
    var Array<char> letters = Array('A', 'B', 'C')

    var int a = elephants.count
    elephants.add(0)
    var int b = elephants.count
    elephants.add(1)
    var int c = elephants.count
    elephants.add(2)
    elephants.set_next(a, b)
    elephants.set_next(b, c)

    var int cur = elephants.head
    while cur >= 0 && cur < elephants.count {
        Console.write("Elephant \\{letters.at(elephants.at(cur))}. ")
        cur = elephants.next_at(cur)
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("046", built, "Elephant A. Elephant B. Elephant C. \n");
});
