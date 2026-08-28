import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Enum-with-data returns use the struct sret convention on aarch64 (the
// caller-provided x8 buffer): a plain x0 return used to hand the caller a
// pointer into the callee's dead frame, which any intervening call (e.g. a
// scope-exit free running after the value was built) overwrote. These encode
// the fixed contract: an enum built by ANOTHER CALL survives being returned
// past cleanup `bl`s, on both backends.

test("enum returned from a call survives return-path cleanup bls", async () => {
	const input = `
enum Load {
  case found(string text)
  case missing
}

func produce = (out Load) {
  return Load.found("payload")
}

func forward = (out Load) {
  var string scratch = "scratch".to_string()
  return produce()
}

match forward() {
  case .found(t) -> Console.write("got:\\{t}")
  case .missing -> Console.write("missing")
}
`;
	await build_and_check_output(input, "enum_sret_return_call", "got:payload");
});

test("enum forwarding chain through nested calls", async () => {
	const input = `
enum Load {
  case found(string text)
  case missing
}

func produce = (out Load) {
  return Load.found("deep")
}

func forward1 = (out Load) {
  var string s1 = "one".to_string()
  return produce()
}

func forward2 = (out Load) {
  var string s2 = "two".to_string()
  return forward1()
}

match forward2() {
  case .found(t) -> Console.write("got:\\{t}")
  case .missing -> Console.write("missing")
}
`;
	await build_and_check_output(input, "enum_sret_return_chain", "got:deep");
});

test("method-call enum return with payload, matched at the call site", async () => {
	const input = `
enum Load {
  case found(string text)
  case missing
}

struct Source {
  func load = (out Load) {
    return Load.found("method")
  }
}

var Source s = Source()
match s.load() {
  case .found(t) -> Console.write("m:\\{t}")
  case .missing -> Console.write("missing")
}
`;
	await build_and_check_output(input, "enum_sret_return_method", "m:method");
});

test("core Option returned from a call keeps its string payload", async () => {
	const input = `
func produce = (out Option<string>) {
  return Option<string>.some("core")
}

func forward = (out Option<string>) {
  var string scratch = "scratch".to_string()
  return produce()
}

var Option<string> r = forward()
match r {
  case .some(t) -> Console.write("opt:\\{t}")
  case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_sret_return_core_option", "opt:core");
});
