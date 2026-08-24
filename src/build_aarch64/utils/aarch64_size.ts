export default function aarch64_size(type: string): number {
	switch (type) {
		case "bool":
		case "int8":
		case "uint8":
		case "char":
			return 1;
		case "int16":
		case "uint16":
			return 2;
		case "int32":
		case "uint32":
			return 4;
		case "float":
		case "ufloat":
		case "float32":
		case "ufloat32":
			return 8;
		case "int":
		case "uint":
		case "int64":
		case "uint64":
		case "float64":
		case "ufloat64":
			return 8;
		case "string":
			// Fat string: the 16-byte { char* ptr; long len; } value. In
			// registers it rides as a consecutive (ptr, len) pair — the same
			// ABI `view T` already uses; in memory it is one 16-byte slot.
			return 16;
		default:
			return 8;
	}
}
