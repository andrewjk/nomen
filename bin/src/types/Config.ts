export default interface Config {
	arch?: "c" | "aarch64";
	lib?: string;
	audit?: boolean;
	audit_runtime?: string;
}
