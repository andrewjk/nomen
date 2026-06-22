import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 038 structs2 -- errors", () => {
	const input = `
import System

enum Role {
  case wizard
  case thief
  case bard
  case warrior
}

struct Character {
  var Role role
  var int gold
  var int health
  var int experience
}

pub func main = () {
    var chars = Array(Character(Role.wizard, 20, 100, 10), Character(???.bard, 10, 100, 20))
    var int num = 1

    for c of chars; num += 1 {
        Console.write("Character \\{num} - G:\\{c.gold} H:\\{c.health} XP:\\{c.experience}\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 038 structs2 -- fixed", () => {
	const input = `
import System

enum Role {
  case wizard
  case thief
  case bard
  case warrior
}

struct Character {
  var Role role
  var int gold
  var int health
  var int experience
}

pub func main = () {
    var chars = Array(Character(Role.wizard, 20, 100, 10), Character(Role.bard, 10, 100, 20))
    var int num = 1

    for c of chars; num += 1 {
        Console.write("Character \\{num} - G:\\{c.gold} H:\\{c.health} XP:\\{c.experience}\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 038 structs2 -- build", async () => {
	const input = `
import System

enum Role {
  case wizard
  case thief
  case bard
  case warrior
}

struct Character {
  var Role role
  var int gold
  var int health
  var int experience
}

pub func main = () {
    var chars = Array(Character(Role.wizard, 20, 100, 10), Character(Role.bard, 10, 100, 20))
    var int num = 1

    for c of chars; num += 1 {
        Console.write("Character \\{num} - G:\\{c.gold} H:\\{c.health} XP:\\{c.experience}\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64(
		"038",
		built,
		"Character 1 - G:20 H:100 XP:10\nCharacter 2 - G:10 H:100 XP:20\n",
	);
});
