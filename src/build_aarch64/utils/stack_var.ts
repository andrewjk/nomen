import type BuildStatus from "../../build_c/BuildStatus.ts";
import aarch64_size from "./aarch64_size.ts";

export function allocate_stack_space(status: BuildStatus, size: number, alignment = 8): number {
	if (!status.stack_size) status.stack_size = 0;
	const aligned_size = Math.ceil(status.stack_size / alignment) * alignment;
	status.stack_size = aligned_size + size;
	return aligned_size;
}

export function get_stack_offset(status: BuildStatus, name: string): number | undefined {
	return status.stack_offsets?.get(name);
}

/**
 * Load a stack slot into a promoted (callee-saved) register with the slot's
 * width. A sub-word slot (bool/char/int8 = strb, int16 = strh, int32 = str w)
 * must be loaded with the matching zero-extending ldrb/ldrh/ldr w — a
 * full-width `ldr` picks up dirty stack bytes above the slot and a bool can
 * read as true regardless of its stored value.
 */
export function emit_promoted_load(
	status: BuildStatus,
	reg: string,
	offset: number,
	type_name: string,
) {
	const size = aarch64_size(type_name);
	if (size === 1) {
		status.code += `ldrb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
	} else if (size === 2) {
		status.code += `ldrh ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
	} else if (size === 4) {
		status.code += `ldr ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
	} else {
		status.code += `ldr ${reg}, [x29, #${offset}]\n`;
	}
}

/**
 * Write a promoted (callee-saved) register back to its stack slot with the
 * slot's width. A full-width `str` into a sub-word slot clobbers the adjacent
 * stack bytes — whatever variable lives there gets corrupted.
 */
export function emit_promoted_store(
	status: BuildStatus,
	reg: string,
	offset: number,
	type_name: string,
) {
	const size = aarch64_size(type_name);
	if (size === 1) {
		status.code += `strb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
	} else if (size === 2) {
		status.code += `strh ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
	} else if (size === 4) {
		status.code += `str ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
	} else {
		status.code += `str ${reg}, [x29, #${offset}]\n`;
	}
}

export function is_local_ref_var(name: string, status: BuildStatus): boolean {
	return !!status.function_ref_params?.has(name) && !status.function_param_regs?.has(name);
}

export function emit_var_address(status: BuildStatus, reg: string, name: string) {
	const alloc_reg = status.register_allocations?.get(name);
	if (alloc_reg) {
		// Variable is in a register - spill it to stack so address is valid.
		// The spill must use the slot's width: a full-width `str` into a
		// sub-word slot (bool/char/int8/int16/int32) clobbers the adjacent
		// stack bytes.
		const offset = status.stack_offsets?.get(name);
		if (offset !== undefined) {
			const decl = status.scoped_declarations.find((d) => d.name === name);
			const type_name = decl?.type?.name || status.variable_types?.get(name)?.name || "";
			if (type_name) {
				emit_promoted_store(status, alloc_reg, offset, type_name);
			} else {
				status.code += `str ${alloc_reg}, [x29, #${offset}]\n`;
			}
		}
	}
	const offset = status.stack_offsets?.get(name);
	if (offset !== undefined) {
		if (status.function_struct_param_slots?.has(name)) {
			// A spilled struct param's slot holds the POINTER to the caller's
			// struct (by-address convention) — the "address of the variable" is
			// the slot's VALUE, not the slot's address.
			status.code += `ldr ${reg}, [x29, #${offset}]\n`;
		} else {
			status.code += `add ${reg}, x29, #${offset}\n`;
		}
	} else {
		const param_reg = status.function_param_regs?.get(name);
		if (param_reg) {
			// Variable is in a callee-saved register — move it to the target reg
			status.code += `mov ${reg}, ${param_reg}\n`;
		} else {
			status.code += `adr ${reg}, ${name}\n`;
		}
	}
}

export function emit_deref_var_address(status: BuildStatus, reg: string, name: string) {
	emit_var_address(status, reg, name);
	if (is_local_ref_var(name, status)) {
		status.code += `ldr ${reg}, [${reg}]\n`;
	}
}

export function emit_var_load(status: BuildStatus, reg: string, name: string, size: number) {
	if (name === "null") {
		status.code += `mov ${reg}, #0\n`;
		return;
	}
	const alloc_reg = status.register_allocations?.get(name);
	if (alloc_reg) {
		if (alloc_reg.startsWith("d") && reg.startsWith("d")) {
			if (reg !== alloc_reg) {
				status.code += `fmov ${reg}, ${alloc_reg}\n`;
			}
		} else if (alloc_reg.startsWith("d")) {
			status.code += `fmov ${reg}, ${alloc_reg}\n`;
		} else if (reg !== alloc_reg) {
			status.code += `mov ${reg}, ${alloc_reg}\n`;
		}
		return;
	}
	const offset = status.stack_offsets?.get(name);
	if (offset !== undefined) {
		// Fat string slot (16 bytes): move the (ptr, len) pair. Only the
		// plain base-register form is supported (x-registers). ldp/stp
		// simm7-scaled range tops out at +504 — split beyond it.
		if (size === 16 && reg.startsWith("x")) {
			const n = parseInt(reg.substring(1), 10);
			if (offset + 8 > 504) {
				status.code += `ldr ${reg}, [x29, #${offset}]\n`;
				status.code += `ldr x${n + 1}, [x29, #${offset + 8}]\n`;
			} else {
				status.code += `ldp ${reg}, x${n + 1}, [x29, #${offset}]\n`;
			}
			return;
		}
		if (size === 1) {
			status.code += `ldrb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else if (size === 2) {
			status.code += `ldrh ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else if (size === 4) {
			status.code += `ldr ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else {
			status.code += `ldr ${reg}, [x29, #${offset}]\n`;
		}
	} else {
		const param_reg = status.function_param_regs?.get(name);
		if (param_reg) {
			if (reg !== param_reg) {
				status.code += `mov ${reg}, ${param_reg}\n`;
			}
		} else {
			status.code += `adr ${reg}, ${name}\n`;
			if (size === 1) {
				status.code += `ldrb ${reg.replace("x", "w")}, [${reg}]\n`;
			} else if (size === 2) {
				status.code += `ldrh ${reg.replace("x", "w")}, [${reg}]\n`;
			} else if (size === 4) {
				status.code += `ldr ${reg.replace("x", "w")}, [${reg}]\n`;
			} else {
				status.code += `ldr ${reg}, [${reg}]\n`;
			}
		}
	}
}

export function emit_var_store(status: BuildStatus, reg: string, name: string, size: number) {
	const alloc_reg = status.register_allocations?.get(name);
	if (alloc_reg) {
		if (alloc_reg.startsWith("d") && reg.startsWith("d")) {
			if (reg !== alloc_reg) {
				status.code += `fmov ${alloc_reg}, ${reg}\n`;
			}
		} else if (alloc_reg.startsWith("d")) {
			status.code += `fmov ${alloc_reg}, ${reg}\n`;
		} else if (reg !== alloc_reg) {
			status.code += `mov ${alloc_reg}, ${reg}\n`;
		}
		return;
	}
	const offset = status.stack_offsets?.get(name);
	if (offset !== undefined) {
		// Fat string slot (16 bytes): store the (ptr, len) pair. Split
		// beyond the ldp/stp +504 range.
		if (size === 16 && reg.startsWith("x")) {
			const n = parseInt(reg.substring(1), 10);
			if (offset + 8 > 504) {
				status.code += `str ${reg}, [x29, #${offset}]\n`;
				status.code += `str x${n + 1}, [x29, #${offset + 8}]\n`;
			} else {
				status.code += `stp ${reg}, x${n + 1}, [x29, #${offset}]\n`;
			}
			return;
		}
		if (size === 1) {
			status.code += `strb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else if (size === 2) {
			status.code += `strh ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else if (size === 4) {
			status.code += `str ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else {
			status.code += `str ${reg}, [x29, #${offset}]\n`;
		}
	} else {
		const param_reg = status.function_param_regs?.get(name);
		if (param_reg) {
			status.code += `mov ${param_reg}, ${reg}\n`;
		} else {
			status.code += `adr x1, ${name}\n`;
			if (size === 1) {
				status.code += `strb ${reg.replace("x", "w")}, [x1]\n`;
			} else if (size === 2) {
				status.code += `strh ${reg.replace("x", "w")}, [x1]\n`;
			} else if (size === 4) {
				status.code += `str ${reg.replace("x", "w")}, [x1]\n`;
			} else {
				status.code += `str ${reg}, [x1]\n`;
			}
		}
	}
}
