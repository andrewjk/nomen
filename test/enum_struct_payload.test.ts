import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Ownership of mv-STRUCT payloads in enum-with-data values: case construction
// transfers the payload's heap state to the blob (enforce_case_payload_ownership
// treats a mv-struct payload like a reference payload), so the enum teardown
// destroys it — the tag-guarded `<T>_destroy` arm in `<E>_free_payloads` /
// emit_enum_payload_frees_at — and every blob copy deep-copies it through the
// payload's `copy` (`<E>_copy` / emit_enum_payload_strdups_at). A string field
// on the payload struct used to leak the field's buffer at every one of these
// deaths (the enum teardown only freed STRING and class/trait payloads).

describe("enum struct payload: teardown", () => {
	test("struct payload with a string field is reclaimed at scope exit", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int id
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

pub func main = (Init init) {
	var RecRes r = RecRes.found(Rec("x", 1))
	match r {
		case .found(rec) -> Console.write("\\{rec.name}\\{rec.id}")
		case .miss -> Console.write("miss")
	}
}
`;
		await build_and_check_output(input, "enum_struct_teardown_local", "x1", true);
	});

	test("reassignment frees the displaced blob's struct payload", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int id
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

pub func main = (Init init) {
	var RecRes r = RecRes.found(Rec("x", 1))
	r = RecRes.found(Rec("y", 2))
	match r {
		case .found(rec) -> Console.write("\\{rec.name}\\{rec.id}")
		case .miss -> Console.write("miss")
	}
	r = .miss
	Console.write("done")
}
`;
		await build_and_check_output(input, "enum_struct_teardown_reassign", "y2done", true);
	});

	test("match on a call scrutinee reclaims the hoisted temp's struct payload", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int id
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

func make = (string s, int k, out RecRes) {
	return RecRes.found(Rec(s.copy(), k))
}

pub func main = (Init init) {
	match make("q", 7) {
		case .found(rec) -> Console.write("\\{rec.name}\\{rec.id}")
		case .miss -> Console.write("miss")
	}
}
`;
		await build_and_check_output(input, "enum_struct_teardown_match_call", "q7", true);
	});
});

describe("enum struct payload: deep copies", () => {
	test("struct payload stored into a struct field owns independent copies", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int id
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

mv struct Holder {
	var RecRes r
}

pub func main = (Init init) {
	var Holder h = Holder(RecRes.found(Rec("x", 1)))
	match h.r {
		case .found(rec) -> Console.write("\\{rec.name}\\{rec.id}")
		case .miss -> Console.write("miss")
	}
}
`;
		await build_and_check_output(input, "enum_struct_copy_field", "x1", true);
	});

	test("struct payload survives container store/load round trips", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int id
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

pub func main = (Init init) {
	var List<RecRes> xs = List<RecRes>()
	xs.push(RecRes.found(Rec("a", 1)))
	xs.push(RecRes.miss)
	xs.push(RecRes.found(Rec("b", 2)))
	var int total = 0
	var int i = 0
	while i < xs.length {
		match xs.at(i) {
			case .found(rec) { total = total + rec.id + rec.name.length }
			case .miss { total = total + 100 }
		}
		i += 1
	}
	Console.write("\\{total}")
}
`;
		// (1 + 1) + 100 + (2 + 1) = 105; every blob's struct payload is
		// deep-copied into the slot and reclaimed exactly once (audit on).
		await build_and_check_output(input, "enum_struct_copy_list", "105", true);
	});
});

describe("enum struct payload: emitted code", () => {
	test("C backend destroys struct payloads and deep-copies them in <E>_copy", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int id
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

pub func main = (Init init) {
	var RecRes r = RecRes.found(Rec("x", 1))
	match r {
		case .found(rec) -> Console.write("\\{rec.name}\\{rec.id}")
		case .miss -> Console.write("miss")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", audit: true });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		// The free helper's struct arm reclaims the payload's owned fields
		// through the destroy walk (tag-guarded) — the string field's buffer
		// is freed via the payload path, not leaked. The copy helper
		// deep-copies the payload through its `copy`.
		const free_at = code.indexOf("void RecRes_free_payloads(");
		const free_body = code.slice(free_at, code.indexOf("}\n", free_at));
		expect(free_body).toContain("if (v->tag == RecRes_found) {");
		expect(free_body).toContain("v->_data._found.rec.name.ptr");
		const copy_at = code.indexOf("RecRes RecRes_copy(");
		const copy_body = code.slice(copy_at, code.indexOf("\n}\n", copy_at));
		expect(copy_body).toContain("r._data._found.rec = Rec_copy(&r._data._found.rec);");
	});

	test("aarch64 backend emits the tag-guarded destroy and copy calls", async () => {
		const input = `
import System

mv struct Rec {
	var string name
	var int id
}

mv enum RecRes {
	case found(Rec rec)
	case miss
}

pub func main = (Init init) {
	var RecRes r = RecRes.found(Rec("x", 1))
	match r {
		case .found(rec) -> Console.write("\\{rec.name}\\{rec.id}")
		case .miss -> Console.write("miss")
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.errors ?? []).toEqual([]);
		const code = result.code ?? "";
		const main_at = code.indexOf("_main:");
		const body = code.slice(main_at);
		// The scope-exit payload free guards on the tag and destroys the
		// payload struct in place.
		expect(body).toContain("bl Rec_destroy");
	});
});
