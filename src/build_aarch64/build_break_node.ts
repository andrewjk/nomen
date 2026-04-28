import type BuildStatus from "../build/BuildStatus.ts";

export default function build_break_node(status: BuildStatus) {
  const loop = status.loop_labels?.[status.loop_labels.length - 1];
  if (loop) {
    status.code += `b ${loop.end}\n`;
  }
}
