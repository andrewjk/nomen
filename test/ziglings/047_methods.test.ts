import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches struct methods (static and instance).
// Echo uses `func name = (self, ...) ` for instance methods (self is a copy)
// and `func name = (Type arg, out Ret)` for static methods.
// Echo requires `ref` keyword at both definition and call site for mutation.
// The Zig version uses arrays with pointer iteration; Echo uses individual
// variables since for-of iterates by value (mutations to copies don't
// propagate back to the array).

test("ziglings 047 methods -- errors", () => {
	const input = `
import System

struct Alien {
    var int health
    func hatch = (int strength, out Alien) {
        return Alien(strength * 5)
    }
}

struct HeatRay {
    var int damage
    func zap = (self, ref Alien alien) {
        if self.damage >= alien.health {
            alien.health = 0
        } else {
            alien.health = alien.health - self.damage
        }
    }
}

pub func main = () {
    var Alien a = Alien.hatch(2)
    var Alien b = Alien.hatch(1)
    var Alien c = Alien.hatch(3)
    var Alien d = Alien.hatch(3)
    var Alien e = Alien.hatch(5)
    var Alien f = Alien.hatch(3)
    var int alive = 6
    var HeatRay ray = HeatRay(7)
    while alive > 0 {
        alive = 0
        ray.zap(a)
        if a.health > 0 { alive = alive + 1 }
        ray.zap(b)
        if b.health > 0 { alive = alive + 1 }
        ray.zap(c)
        if c.health > 0 { alive = alive + 1 }
        ray.zap(d)
        if d.health > 0 { alive = alive + 1 }
        ray.zap(e)
        if e.health > 0 { alive = alive + 1 }
        ray.zap(f)
        if f.health > 0 { alive = alive + 1 }
        Console.write("\\{alive} aliens. ")
    }
    Console.write("Earth is saved!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 047 methods -- fixed", () => {
	const input = `
import System

struct Alien {
    var int health
    func hatch = (int strength, out Alien) {
        return Alien(strength * 5)
    }
}

struct HeatRay {
    var int damage
    func zap = (self, ref Alien alien) {
        if self.damage >= alien.health {
            alien.health = 0
        } else {
            alien.health = alien.health - self.damage
        }
    }
}

pub func main = () {
    var Alien a = Alien.hatch(2)
    var Alien b = Alien.hatch(1)
    var Alien c = Alien.hatch(3)
    var Alien d = Alien.hatch(3)
    var Alien e = Alien.hatch(5)
    var Alien f = Alien.hatch(3)
    var int alive = 6
    var HeatRay ray = HeatRay(7)
    while alive > 0 {
        alive = 0
        ray.zap(ref a)
        if a.health > 0 { alive = alive + 1 }
        ray.zap(ref b)
        if b.health > 0 { alive = alive + 1 }
        ray.zap(ref c)
        if c.health > 0 { alive = alive + 1 }
        ray.zap(ref d)
        if d.health > 0 { alive = alive + 1 }
        ray.zap(ref e)
        if e.health > 0 { alive = alive + 1 }
        ray.zap(ref f)
        if f.health > 0 { alive = alive + 1 }
        Console.write("\\{alive} aliens. ")
    }
    Console.write("Earth is saved!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 047 methods -- build", async () => {
	const input = `
import System

struct Alien {
    var int health
    func hatch = (int strength, out Alien) {
        return Alien(strength * 5)
    }
}

struct HeatRay {
    var int damage
    func zap = (self, ref Alien alien) {
        if self.damage >= alien.health {
            alien.health = 0
        } else {
            alien.health = alien.health - self.damage
        }
    }
}

pub func main = () {
    var Alien a = Alien.hatch(2)
    var Alien b = Alien.hatch(1)
    var Alien c = Alien.hatch(3)
    var Alien d = Alien.hatch(3)
    var Alien e = Alien.hatch(5)
    var Alien f = Alien.hatch(3)
    var int alive = 6
    var HeatRay ray = HeatRay(7)
    while alive > 0 {
        alive = 0
        ray.zap(ref a)
        if a.health > 0 { alive = alive + 1 }
        ray.zap(ref b)
        if b.health > 0 { alive = alive + 1 }
        ray.zap(ref c)
        if c.health > 0 { alive = alive + 1 }
        ray.zap(ref d)
        if d.health > 0 { alive = alive + 1 }
        ray.zap(ref e)
        if e.health > 0 { alive = alive + 1 }
        ray.zap(ref f)
        if f.health > 0 { alive = alive + 1 }
        Console.write("\\{alive} aliens. ")
    }
    Console.write("Earth is saved!\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("047", built, "5 aliens. 4 aliens. 1 aliens. 0 aliens. Earth is saved!\n");
});
