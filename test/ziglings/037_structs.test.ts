import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 037 structs -- errors", () => {
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
  var int experience
}

pub func main = () {
    var Character glorp = Character(Role.wizard, 20, 10, ???)
    glorp.gold = glorp.gold + 5
    glorp.health = glorp.health - 10
    Console.write("Your wizard has \\{glorp.health} health and \\{glorp.gold} gold")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 037 structs -- fixed", () => {
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
  var int experience
  var int health
}

pub func main = () {
    var Character glorp = Character(Role.wizard, 20, 10, 100)
    glorp.gold = glorp.gold + 5
    glorp.health = glorp.health - 10
    Console.write("Your wizard has \\{glorp.health} health and \\{glorp.gold} gold")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 037 structs -- build", async () => {
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
  var int experience
  var int health
}

pub func main = () {
    var Character glorp = Character(Role.wizard, 20, 10, 100)
    glorp.gold = glorp.gold + 5
    glorp.health = glorp.health - 10
    Console.write("Your wizard has \\{glorp.health} health and \\{glorp.gold} gold")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("037", built, "Your wizard has 90 health and 25 gold");
});
