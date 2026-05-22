import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise uses a doubly-linked list with tail/trunk pointers,
// traversing tails forward then trunks backward. The visited flag is set during
// the first pass and checked during the second.
//
// Echo's `ref` params now support proper pointer reassignment — `current = current.tail`
// updates the reference to point to the next elephant rather than copying struct data.
// This allows a general-purpose traversal loop matching the Zig structure.

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

test("ziglings 049 quiz6 -- fixed", () => {
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
	expect(parsed.errors).toEqual([]);
});

test("ziglings 049 quiz6 -- build", async () => {
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
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0496", built, "A  B  C  Cv Bv Av \n");
});
