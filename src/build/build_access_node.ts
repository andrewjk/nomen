import AccessInvocationNode from "../nodes/AccessInvocationNode";
import AccessNode from "../nodes/AccessNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import c_type from "./c_type";
import type_from_value_node from "./type_from_value_node";

export default function build_access_node(node: AccessNode, status: BuildStatus) {
  switch (node.access.node_type) {
    case "ac_field": {
      build_node(node.source, status);
      status.code += `.${node.access.name}`;
      break;
    }
    case "ac_invoke": {
      // Convert the access function into a C function that takes the struct as an argument
      const invoke = node.access as AccessInvocationNode;
      const type = type_from_value_node(node.source);

      // PERF
      const trait = status.traits.find((t) => t.name === type.name);
      if (trait) {
        const func = trait.functions.find((f) => f.name == invoke.name)!;
        // TODO: Cast to the correct function definition
        // TODO: Use the correct variable name
        // TODO: Pass parameters
        const cast = "(char *(*)(void *))";
        status.code += `(${cast} * _get_trait_func(`;
        build_node(node.source, status);
        status.code += `, ${status.traits.indexOf(trait)}, ${trait.functions.indexOf(func)}))(`;
        build_node(node.source, status);
        status.code += `)`;
      } else {
        status.code += `${c_type(type.name)}_${invoke.name}(`;
        if (!invoke.static) {
          status.code += "&";
          build_node(node.source, status);
        }
        for (let i = 0; i < invoke.params.length; i++) {
          if (!invoke.static || i > 0) {
            status.code += ", ";
          }
          build_node(invoke.params[i], status);
        }
        status.code += ")";
      }
      break;
    }
  }
}
