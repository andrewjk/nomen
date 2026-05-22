import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches struct methods on an Elephant linked list.
// Echo uses `(self)` for read-only self and `(var self)` for mutable copy self.
// Note: `(var self)` mutations are local to the copy and don't propagate back.
// Since each elephant is printed before visit() is called, the output is unaffected.
// The `ref Elephant? tail` field uses `ref` for pointer-like semantics.
// `getTail` is omitted since returning a nullable ref field as a struct has
// type complications; direct field access `current.tail` is used instead.

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

test("ziglings 048 methods2 -- fixed", () => {
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
	expect(parsed.errors).toEqual([]);
});

test("ziglings 048 methods2 -- build", async () => {
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
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("0482", built, "A  B  C  \n");
});
