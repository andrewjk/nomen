/**
 * Compiler-synthesized binding names (receiver-hoist `_recv_N`, discard
 * `_disc_N`, destructure `_tuple_dst_N`, call-temp `_param_N`). A "donor"
 * with one of these names is a fresh compiler temp — no user owner, no
 * records to transfer; ownership rows must not fire on it. Shared by both
 * backends' call/declaration ownership paths.
 */
const COMPILER_TEMP_PREFIXES = ["_recv_", "_disc_", "_tuple_dst_", "_param_"];

export default function is_compiler_temp_name(name: string | undefined): boolean {
	return !!name && COMPILER_TEMP_PREFIXES.some((p) => name.startsWith(p));
}
