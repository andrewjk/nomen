import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { FIBER_HEADER, POOL_HEADER } from "../src/build_c/build_spawn_node";
import { globalize_runtime, runtime_declarations } from "../src/build_c/runtime_split";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

describe("C runtime TU split", () => {
	test("declarations cover every symbol the runtime defines (no drift)", () => {
		const defined = new Set(
			(POOL_HEADER + FIBER_HEADER).match(/__nomen_[a-z_0-9]+|nomen_fiber_ctx/g) ?? [],
		);
		const declared = new Set(
			runtime_declarations().match(/__nomen_[a-z_0-9]+|nomen_fiber_ctx/g) ?? [],
		);
		for (const sym of defined) {
			expect(declared.has(sym), `declaration missing for ${sym}`).toBe(true);
		}
	});

	test("globalize strips file-scope static only", () => {
		const out = globalize_runtime("static int x = 1;\nstatic int f(void) {\n\treturn x;\n}\n");
		expect(out).toBe("int x = 1;\nint f(void) {\n\treturn x;\n}\n");
	});

	test("declarations turn globals extern and definitions prototypes", () => {
		const decls = runtime_declarations();
		expect(decls).toContain("extern __thread unsigned long long *__nomen_current_cancel_flag;");
		expect(decls).toContain("extern __thread struct nomen_fiber *__nomen_current_fiber;");
		expect(decls).toContain("extern pthread_mutex_t __nomen_pool_mu;");
		expect(decls).toContain("void __nomen_pool_submit(struct nomen_closure *task);");
		expect(decls).toContain("void __nomen_closure_dispose(struct nomen_closure *c);");
		expect(decls).toContain("void *__nomen_mutex_create(void);");
		// The definitions blob (statics) must NOT leak into the declarations.
		expect(decls).not.toMatch(/^static /m);
		// Struct/enum/typedef shapes (with bodies) are copied so user TUs can
		// name the types.
		expect(decls).toContain("typedef ucontext_t nomen_fiber_ctx;");
		expect(decls).toContain("\tint done;");
		expect(decls).toContain("struct nomen_future {");
		// Platform-split symbols keep their conditional skeleton.
		expect(decls).toContain("#if defined(__APPLE__)");
		expect(decls).toContain("extern int __nomen_io_kq;");
		expect(decls).toContain("extern int __nomen_io_epfd;");
	});
});

describe("split-build runtime sharing (C system_lib)", () => {
	// The concurrency runtime must exist ONCE per process: a user fiber's
	// Channel.receive parks it (the system copy's __nomen_current_fiber is
	// set), so a fiber waiting on the channel frees its worker instead of
	// blocking it. With per-TU runtime copies the library body saw the
	// system copy's NULL current-fiber and blocked the worker instead.
	test("user fiber parks through the shared runtime in a system_lib build", async () => {
		const input = `
import System

func producer = (Channel ch) {
	ch.send(42)
}

pub func main = () {
	var Channel ch = Channel()
	async {
		var t = Thread(producer(ch)).start()
	}
	var uint64 v = ch.receive()
	Console.write_line(v.to_string())
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const { load_system_struct_names } = await import("./system_lib");
		const result = build(parsed.root, {
			arch: "c",
			audit: true,
			emit_mode: "user",
			system_struct_names: load_system_struct_names(),
		});
		// The user TU must declare — not define — the runtime: no static
		// definitions in its text (the declarations come from system.h, and
		// its trampolines call into system.o).
		expect(result.code).not.toContain("static __thread struct nomen_fiber *__nomen_current_fiber");
		expect(result.code + (result.headers ?? "")).toContain("__nomen_future_complete");
		await check_output("split_runtime_shared", result, "42\n", {
			arch: "c",
			audit: true,
			system_lib: true,
		});
	});

	test("the system TU defines the runtime with external linkage, exactly once", () => {
		const parsed = parse_raw(
			"import System\n\npub func main = () {\n\tvar Mutex m = Mutex()\n\tm.lock()\n\tm.unlock()\n}\n",
		);
		expect(parsed.errors).toEqual([]);
		const sys = build(parsed.root, { arch: "c", audit: true, emit_mode: "system" });
		expect(sys.code).not.toMatch(/^static __thread struct nomen_fiber \*__nomen_current_fiber/m);
		expect(sys.headers ?? "").not.toContain(
			"static __thread struct nomen_fiber *__nomen_current_fiber",
		);
		expect(sys.headers ?? "").toContain(
			"extern __thread struct nomen_fiber *__nomen_current_fiber;",
		);
		// Exactly one definition of the TLS anchor in the system TU.
		expect(
			sys.code.match(/^__thread struct nomen_fiber \*__nomen_current_fiber = NULL;$/gm)?.length,
		).toBe(1);
	});
});
