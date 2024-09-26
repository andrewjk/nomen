import type BuildStatus from "./BuildStatus";

export default function build_auto_free(status: BuildStatus) {
  // Add dispose calls, if applicable
  // TODO: free() if it's on the heap
  let have_scoped = false;
  for (const dec of status.scoped_declarations) {
    // Only if it has the Disposable trait
    const struct = status.structs.find((s) => s.name === dec.type.name);
    if (struct && struct.traits.includes("Disposable")) {
      const trait = status.traits.find((t) => t.name === "Disposable");
      const func = trait?.functions.find((f) => f.name == "dispose");
      if (trait && func) {
        if (!have_scoped) {
          status.code += "\n";
          have_scoped = true;
        }
        const cast = "(void *(*)(void *))";
        const traitIndex = status.traits.indexOf(trait);
        const funcIndex = trait.functions.indexOf(func);
        status.code += `(${cast}_get_trait_func((void *)&${dec.name}, ${traitIndex}, ${funcIndex}))(&${dec.name});\n`;
      }
    }
  }
}
