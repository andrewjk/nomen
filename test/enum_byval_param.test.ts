import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("16-byte enum-with-data by-value param (aarch64 ABI gap)", () => {
	test("enum-with-data passed by value to a function", async () => {
		const input = `
enum Length {
  case auto
  case fixed(int pixels)
  case percent(int numerator)
}
func resolve = (Length len, int avail, out int) {
  var int r = match len {
    case .auto -> avail
    case .fixed(v) -> v
    case .percent(p) -> avail * p / 100
  }
  return r
}
var Length a = Length.fixed(100)
var Length b = Length.percent(50)
var Length c = Length.auto
Console.write("\\{resolve(a, 300)} \\{resolve(b, 300)} \\{resolve(c, 300)}")
`;
		await build_and_check_output(input, "enum_data_byval_param", "100 150 300");
	});

	test("inline enum-with-data literal arg", async () => {
		const input = `
enum Length {
  case auto
  case fixed(int pixels)
  case percent(int numerator)
}
func resolve = (Length len, int avail, out int) {
  var int r = match len {
    case .auto -> avail
    case .fixed(v) -> v
    case .percent(p) -> avail * p / 100
  }
  return r
}
Console.write("\\{resolve(Length.fixed(100), 300)} \\{resolve(Length.percent(50), 300)}")
`;
		await build_and_check_output(input, "enum_data_byval_inline_arg", "100 150");
	});

	test("two enum-with-data params", async () => {
		const input = `
enum Length {
  case auto
  case fixed(int pixels)
  case percent(int numerator)
}
func resolve = (Length w, Length h, int avail, out int) {
  var int rw = match w {
    case .auto -> avail
    case .fixed(v) -> v
    case .percent(p) -> avail * p / 100
  }
  var int rh = match h {
    case .auto -> avail
    case .fixed(v) -> v
    case .percent(p) -> avail * p / 100
  }
  return rw * 1000 + rh
}
var Length w = Length.fixed(120)
var Length h = Length.percent(25)
Console.write("\\{resolve(w, h, 200)}")
`;
		await build_and_check_output(input, "enum_data_byval_two_params", "120050");
	});

	test("enum-with-data passed by value to a struct method", async () => {
		const input = `
enum Length {
  case auto
  case fixed(int pixels)
  case percent(int numerator)
}
struct Layout {
  var int avail = 0
  pub func resolve = (self, Length len, out int) {
    var int r = match len {
      case .auto -> self.avail
      case .fixed(v) -> v
      case .percent(p) -> self.avail * p / 100
    }
    return r
  }
}
var Layout l = Layout()
l.avail = 300
var Length a = Length.fixed(100)
Console.write("\\{l.resolve(a)} \\{l.resolve(Length.percent(50))} \\{l.resolve(Length.auto)}")
`;
		await build_and_check_output(input, "enum_data_byval_method", "100 150 300");
	});

	test("two enum-with-data args to a struct method (add_len shape)", async () => {
		const input = `
enum Length {
  case auto
  case fixed(int pixels)
  case percent(int numerator)
}
struct Container {
  var int avail = 0
  pub func add_len = (self, Length w, Length h, int span, out int) {
    var int rw = match w {
      case .auto -> self.avail
      case .fixed(v) -> v
      case .percent(p) -> self.avail * p / 100
    }
    var int rh = match h {
      case .auto -> self.avail
      case .fixed(v) -> v
      case .percent(p) -> self.avail * p / 100
    }
    return rw * 10000 + rh * 10 + span
  }
}
var Container c = Container()
c.avail = 200
Console.write("\\{c.add_len(Length.fixed(100), Length.percent(30), 2)}")
`;
		await build_and_check_output(input, "enum_data_byval_method_two", "1000602");
	});

	test("enum-with-data passed by value to an inline method", async () => {
		const input = `
enum Length {
  case auto
  case fixed(int pixels)
  case percent(int numerator)
}
struct Layout {
  var int avail = 0
  inline func resolve = (self, Length len, out int) {
    var int r = match len {
      case .auto -> self.avail
      case .fixed(v) -> v
      case .percent(p) -> self.avail * p / 100
    }
    return r
  }
}
var Layout l = Layout()
l.avail = 300
var Length a = Length.fixed(100)
Console.write("\\{l.resolve(a)} \\{l.resolve(Length.percent(50))} \\{l.resolve(Length.auto)}")
`;
		await build_and_check_output(input, "enum_data_byval_inline_method", "100 150 300");
	});

	test("match on enum param inside method arm reads self fields", async () => {
		const input = `
enum State {
  case idle
  case running(int speed)
}
struct Machine {
  var int base = 7
  pub func describe = (self, State s, out int) {
    var int r = match s {
      case .idle -> self.base
      case .running(v) -> self.base + v
    }
    return r
  }
}
var Machine m = Machine()
Console.write("\\{m.describe(State.running(5))} \\{m.describe(State.idle)}")
`;
		await build_and_check_output(input, "enum_data_match_self_field", "12 7");
	});
});
