import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Enums with owning (string) payloads as generic-container element types:
// Buffer_<Enum> slots own independent deep copies (store/replace/load/destroy),
// List<Enum> builds on top, and a match binding that escapes its branch returns
// an owning copy. Audit is ON in build_and_check_output, so any leak / double
// free / use-after-free fails the test.

test("List<enum> reads an element back twice", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

var List<Maybe> xs = List<Maybe>()
xs.push(Maybe.some("one"))
xs.push(Maybe.some("two"))
match xs.at_or(0, Maybe.none) {
  case .some(v) -> Console.write("a:\\{v}")
  case .none -> Console.write("a:none")
}
match xs.at_or(1, Maybe.none) {
  case .some(v) -> Console.write(" b:\\{v}")
  case .none -> Console.write(" b:none")
}
match xs.at_or(0, Maybe.none) {
  case .some(v) -> Console.write(" c:\\{v}")
  case .none -> Console.write(" c:none")
}
`;
	await build_and_check_output(input, "enum_container_read_twice", "a:one b:two c:one");
});

test("List<enum> element bound to a local then matched", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

var List<Maybe> xs = List<Maybe>()
xs.push(Maybe.some("bound"))
var Maybe m = xs.at_or(0, Maybe.none)
match m {
  case .some(v) -> Console.write("got:\\{v}")
  case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_container_local", "got:bound");
});

test("List<enum> set replaces the displaced payload", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

var List<Maybe> xs = List<Maybe>()
xs.push(Maybe.some("first"))
var Maybe second = Maybe.some("second")
var int i = 0
if i >= 0 && i < xs.length {
  xs.set(i, second)
}
match xs.at_or(0, Maybe.none) {
  case .some(v) -> Console.write("got:\\{v}")
  case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_container_set", "got:second");
});

test("List<enum> pop transfers the payload out", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

var List<Maybe> xs = List<Maybe>()
xs.push(Maybe.some("popped"))
var Maybe m = xs.pop()
match m {
  case .some(v) -> Console.write("got:\\{v}")
  case .none -> Console.write("none")
}
`;
	await build_and_check_output(input, "enum_container_pop", "got:popped");
});

test("Buffer<enum> direct store / load / destroy", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

var Buffer<Maybe> b = Buffer<Maybe>()
b.grow(2)
b.store(0, Maybe.some("buf"))
b.replace(1, Maybe.some("rep"))
match b.load(0) {
  case .some(v) -> Console.write("a:\\{v}")
  case .none -> Console.write("a:none")
}
match b.load(1) {
  case .some(v) -> Console.write(" b:\\{v}")
  case .none -> Console.write(" b:none")
}
`;
	await build_and_check_output(input, "enum_container_buffer", "a:buf b:rep");
});

test("a match binding escapes its branch through a return", async () => {
	const input = `
enum Maybe {
  case some(string value)
  case none
}

func pick = (Maybe m, out string) {
  return match m {
    case .some(v) -> v
    case .none -> "none"
  }
}

var Maybe m = Maybe.some("escaped")
Console.write(pick(m))
`;
	await build_and_check_output(input, "enum_container_match_escape", "escaped");
});
