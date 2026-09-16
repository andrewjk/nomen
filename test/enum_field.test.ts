import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Ownership of enum-with-string-payload values stored INSIDE structs, on both
// backends: construction copies the payload into the field, reassignment frees
// the displaced payload and copies the new one, struct destroy walks enum
// fields, and the sret boundary takes owning copies on field-read returns.

test("enum field constructed inline and matched through the field", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

struct Holder {
  var Maybe m
}

var Holder h = Holder(Maybe.some("inline"))
match h.m {
  case .some(v) -> Console.write("got:\\{v}")
  case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_field_inline", "got:inline");
});

test("enum field reassignment frees the displaced payload", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

struct Holder {
  var Maybe m
}

var Holder h = Holder(Maybe.none)
h.m = Maybe.some("first")
match h.m {
  case .some(v) -> Console.write("a:\\{v}")
  case .none -> Console.write("a:none")
}
h.m = Maybe.some("second")
match h.m {
  case .some(v) -> Console.write(" b:\\{v}")
  case .none -> Console.write(" b:none")
}
`;
	await build_and_check_output(input, "enum_field_reassign", "a:first b:second");
});

test("enum field survives a factory return boundary", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

struct Holder {
  var Maybe m
}

func make = (out Holder) {
  var Holder h = Holder(Maybe.some("factory"))
  return h
}

var Holder h = make()
match h.m {
  case .some(v) -> Console.write("got:\\{v}")
  case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_field_factory", "got:factory");
});

test("enum field read returned through the sret boundary", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

struct Holder {
  var Maybe m
  pub func get = (self, out Maybe) {
    return self.m
  }
}

var Holder h = Holder(Maybe.some("sret"))
match h.get() {
  case .some(v) -> Console.write("got:\\{v}")
  case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_field_sret", "got:sret");
});
