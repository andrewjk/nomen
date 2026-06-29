import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches struct methods on an Elephant linked list.
// Three steps:
//  -- errors: the original broken pattern (`current.tail()` used as a bool).
//  -- fixed with safety checks: the original "fixed" pattern, which used
//     `ref Elephant?` fields -- now rejected by the ref-field safety check.
//  -- build: the current arena LinkedList version, which builds/runs.

test("ziglings 048 methods2 -- errors", () => {
	const input = `
import System

struct Elephant {
    var char letter
    var ref Elephant? tail = null
    var bool visited = false

    func visit = (var self) {
        self.visited = true
    }

    func print = (self) {
        if self.visited {
            Console.write("\\{self.letter}v ")
        } else {
            Console.write("\\{self.letter}  ")
        }
    }

    func hasTail = (self, out bool) {
        return self.tail != null
    }
}

func visitElephants = (ref Elephant current) {
    while true {
        current.print()
        current.visit()
        if current.tail() {
            current = current.tail
        } else {
            break
        }
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
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 048 methods2 -- fixed with safety checks", () => {
	const input = `
import System

struct Elephant {
    var char letter
    var ref Elephant? tail = null
    var bool visited = false

    func visit = (var self) {
        self.visited = true
    }

    func print = (self) {
        if self.visited {
            Console.write("\\{self.letter}v ")
        } else {
            Console.write("\\{self.letter}  ")
        }
    }

    func hasTail = (self, out bool) {
        return self.tail != null
    }
}

func visitElephants = (ref Elephant current) {
    while true {
        current.print()
        current.visit()
        if current.hasTail() {
            current = current.tail
        } else {
            break
        }
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
	// The `ref Elephant? tail` field is a non-owning borrow; the safety check
	// rejects it at compile time rather than risking a dangling reference.
	expect(parsed.errors.some((e) => e.message.includes("fields cannot be 'ref'"))).toBe(true);
});

test("ziglings 048 methods2 -- build", async () => {
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
        var int idx = elephants.at(cur)
        if idx >= 0 && idx < letters.length {
            Console.write("\\{letters.at(idx)}  ")
        }
        cur = elephants.next_at(cur)
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0482", built, "A  B  C  \n");
});
