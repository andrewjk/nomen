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
    var Character[2] chars = [Character(Role.wizard, 20, 100, 10), Character(???.bard, 10, 100, 20)]

    for c of chars {
        Console.write("G:\\{c.gold} H:\\{c.health} XP:\\{c.experience}\\n")
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
    var Character[2] chars = [Character(Role.wizard, 20, 100, 10), Character(Role.bard, 10, 100, 20)]

    for c of chars {
        Console.write("G:\\{c.gold} H:\\{c.health} XP:\\{c.experience}\\n")
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
    var Character[2] chars = [Character(Role.wizard, 20, 100, 10), Character(Role.bard, 10, 100, 20)]

    for c of chars {
        Console.write("G:\\{c.gold} H:\\{c.health} XP:\\{c.experience}\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("038", built, "G:20 H:100 XP:10\nG:10 H:100 XP:20\n");
});
