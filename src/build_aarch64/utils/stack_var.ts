import type BuildStatus from "../../build/BuildStatus.ts";

export function allocate_stack_space(status: BuildStatus, size: number, alignment = 8): number {
	if (!status.stack_size) status.stack_size = 0;
	const aligned_size = Math.ceil(status.stack_size / alignment) * alignment;
	status.stack_size = aligned_size + size;
	return aligned_size;
}

export function get_stack_offset(status: BuildStatus, name: string): number | undefined {
	return status.stack_offsets?.get(name);
}

export function is_local_ref_var(name: string, status: BuildStatus): boolean {
	return !!status.function_ref_params?.has(name) && !status.function_param_regs?.has(name);
}

export function emit_var_address(status: BuildStatus, reg: string, name: string) {
	const offset = status.stack_offsets?.get(name);
	if (offset !== undefined) {
		status.code += `add ${reg}, x29, #${offset}\n`;
	} else {
		status.code += `adr ${reg}, ${name}\n`;
	}
}

export function emit_deref_var_address(status: BuildStatus, reg: string, name: string) {
	emit_var_address(status, reg, name);
	if (is_local_ref_var(name, status)) {
		status.code += `ldr ${reg}, [${reg}]\n`;
	}
}

export function emit_var_load(status: BuildStatus, reg: string, name: string, size: number) {
	const offset = status.stack_offsets?.get(name);
	if (offset !== undefined) {
		if (size === 1) {
			status.code += `ldrb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else if (size === 4) {
			status.code += `ldr ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else {
			status.code += `ldr ${reg}, [x29, #${offset}]\n`;
		}
	} else {
		status.code += `adr ${reg}, ${name}\n`;
		if (size === 1) {
			status.code += `ldrb ${reg.replace("x", "w")}, [${reg}]\n`;
		} else if (size === 4) {
			status.code += `ldr ${reg.replace("x", "w")}, [${reg}]\n`;
		} else {
			status.code += `ldr ${reg}, [${reg}]\n`;
		}
	}
}

export function emit_var_store(status: BuildStatus, reg: string, name: string, size: number) {
	const offset = status.stack_offsets?.get(name);
	if (offset !== undefined) {
		if (size === 1) {
			status.code += `strb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else if (size === 4) {
			status.code += `str ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
		} else {
			status.code += `str ${reg}, [x29, #${offset}]\n`;
		}
	} else {
		status.code += `adr x1, ${name}\n`;
		if (size === 1) {
			status.code += `strb ${reg.replace("x", "w")}, [x1]\n`;
		} else if (size === 4) {
			status.code += `str ${reg.replace("x", "w")}, [x1]\n`;
		} else {
			status.code += `str ${reg}, [x1]\n`;
		}
	}
}
