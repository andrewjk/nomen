import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("local ref var -- field access and assignment", async () => {
	const input = `
import System

struct Character {
    var int gold
    var int health = 100
    var int experience = 0
}

func setGold = (ref Character c, int val) {
    c.gold = val
}

func levelUp = (ref Character c, int xp) {
    c.experience = c.experience + xp
}

pub func main = () {
    var Character glorp = Character(30)

    var Character glorp_access1 = glorp
    glorp_access1.gold = 111
    Console.write("1:\\{glorp.gold == glorp_access1.gold}!. ")

    var ref Character glorp_access2 = glorp
    glorp_access2.gold = 222
    Console.write("2:\\{glorp.gold == glorp_access2.gold}!. ")

    var ref Character glorp_access3 = glorp
    glorp_access3.gold = 333
    Console.write("3:\\{glorp.gold == glorp_access3.gold}!. ")

    Console.write("XP before:\\{glorp.experience}, ")
    levelUp(ref glorp, 200)
    Console.write("after:\\{glorp.experience}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64(
		"local_ref1",
		built,
		"1:false!. 2:true!. 3:true!. XP before:0, after:200.\n",
	);
});

test("local ref var -- reassignment updates pointer", async () => {
	const input = `
import System

struct Elephant {
    var char letter
    var bool visited = false
}

pub func main = () {
    var Elephant elephantA = Elephant('A')
    var Elephant elephantB = Elephant('B')

    var ref Elephant current = elephantA
    Console.write("\\{current.letter} ")
    current.visited = true

    current = elephantB
    Console.write("\\{current.letter} ")
    current.visited = true

    Console.write("A:\\{elephantA.visited} B:\\{elephantB.visited}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("local_ref2", built, "A B A:true B:true\n");
});

test("local ref var -- passed to function", async () => {
	const input = `
import System

struct Point {
    var int x = 0
    var int y = 0
}

func bump = (ref Point p) {
    p.x = p.x + 1
    p.y = p.y + 1
}

pub func main = () {
    var Point a = Point()
    var Point b = Point()
    a.x = 5
    b.x = 10
    var ref Point current = a
    bump(ref current)
    Console.write("a:\\{a.x},\\{a.y} ")

    current = b
    bump(ref current)
    Console.write("b:\\{b.x},\\{b.y}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("local_ref3", built, "a:6,1 b:11,1\n");
});
