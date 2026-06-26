import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise uses a doubly-linked list with tail/trunk pointers,
// traversing tails forward then trunks backward. Three steps:
//  -- errors: the original broken pattern (calls hasTrunk, which is undefined).
//  -- fixed with safety checks: the original "fixed" pattern, which used
//     `ref Elephant? tail/trunk` fields -- now rejected by the ref-field
//     safety check.
//  -- build: the current arena Tree version (left = tail, right = trunk),
//     which builds/runs.

test("ziglings 049 quiz6 -- errors", () => {
	const input = `
import System

struct Elephant {
    var char letter
    var ref Elephant? tail = null
    var ref Elephant? trunk = null
    var bool visited = false

    func hasTail = (self, out bool) {
        return self.tail != null
    }

    func print = (self) {
        if self.visited {
            Console.write("\\{self.letter}v ")
        } else {
            Console.write("\\{self.letter}  ")
        }
    }
}

func visitElephants = (ref Elephant current) {
    while true {
        current.print()
        current.visited = true
        if current.hasTail() {
            current = current.tail
        } else {
            break
        }
    }
    while true {
        current.print()
        if current.hasTrunk() {
            current = current.trunk
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
    elephantB.trunk = elephantA
    elephantC.trunk = elephantB

    visitElephants(ref elephantA)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 049 quiz6 -- fixed with safety checks", () => {
	const input = `
import System

struct Elephant {
    var char letter
    var ref Elephant? tail = null
    var ref Elephant? trunk = null
    var bool visited = false

    func hasTail = (self, out bool) {
        return self.tail != null
    }

    func hasTrunk = (self, out bool) {
        return self.trunk != null
    }

    func print = (self) {
        if self.visited {
            Console.write("\\{self.letter}v ")
        } else {
            Console.write("\\{self.letter}  ")
        }
    }
}

func visitElephants = (ref Elephant current) {
    while true {
        current.print()
        current.visited = true
        if current.hasTail() {
            current = current.tail
        } else {
            break
        }
    }
    while true {
        current.print()
        if current.hasTrunk() {
            current = current.trunk
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
    elephantB.trunk = elephantA
    elephantC.trunk = elephantB

    visitElephants(ref elephantA)
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	// The `ref Elephant? tail/trunk` fields are non-owning borrows; the safety
	// check rejects them at compile time.
	expect(parsed.errors.some((e) => e.message.includes("fields cannot be 'ref'"))).toBe(true);
});

test("ziglings 049 quiz6 -- build", async () => {
	const input = `
import System

pub func main = () {
    var Tree<int> tree = Tree<int>()
    var Array<char> letters = Array('A', 'B', 'C')
    var Array<bool> visited = Array(false, false, false)

    tree.add(0)
    tree.add(1)
    tree.add(2)
    tree.set_left(0, 1)
    tree.set_left(1, 2)
    tree.set_right(1, 0)
    tree.set_right(2, 1)

    var int cur = 0
    while true {
        if visited.at(cur) {
            Console.write("\\{letters.at(cur)}v ")
        } else {
            Console.write("\\{letters.at(cur)}  ")
        }
        visited.set(cur, true)
        var int n = tree.left(cur)
        if n == -1 {
            break
        }
        cur = n
    }
    while true {
        if visited.at(cur) {
            Console.write("\\{letters.at(cur)}v ")
        } else {
            Console.write("\\{letters.at(cur)}  ")
        }
        var int n = tree.right(cur)
        if n == -1 {
            break
        }
        cur = n
    }
    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0496", built, "A  B  C  Cv Bv Av \n");
});
