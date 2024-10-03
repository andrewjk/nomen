import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode";
import AccessNode from "../nodes/AccessNode";
import FunctionNode from "../nodes/FunctionNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import c_type from "./utils/c_type";
import type_from_value_node from "./utils/type_from_value_node";

export default function build_access_node(node: AccessNode, status: BuildStatus) {
  // PERF:
  const type = type_from_value_node(node.target);
  const trait = status.traits.find((t) => t.name === type.name);

  switch (node.access.node_type) {
    case "access_field": {
      const access_field = node.access as AccessFieldNode;
      if (trait) {
        // If the target is a trait, we need to call the get/set method
        const traitField = trait.fields.find((f) => f.name == access_field.name)!;
        // TODO: Cast to the correct function definition
        // TODO: Use the correct variable name
        // TODO: Pass parameters
        const type = c_type(traitField.type.name);
        const cast = `(${type}(*)(void *))`;
        status.code += `(${cast}_get_trait_func((void *)`;
        build_node(node.target, status);
        const trait_index = status.traits.indexOf(trait);
        const field_index = trait.functions.length + trait.fields.indexOf(traitField) * 2;
        status.code += `, ${trait_index}, ${field_index}))(`;
        build_node(node.target, status);
        status.code += `)`;
        break;
      } else {
        // If the target is a struct, we can just access the field directly
        build_node(node.target, status);
        status.code += `.${node.access.name}`;
      }
      break;
    }
    case "access_func": {
      const access_func = node.access as AccessFunctionCallNode;
      if (trait) {
        // If the target is a trait, we need to find the correct function to
        // call from the vtable
        const trait_func = trait.functions.find((f) => f.name == access_func.name)!;
        // TODO: Cast to the correct function definition
        // TODO: Use the correct variable name
        // TODO: Pass parameters
        const cast = "(char *(*)(void *))";
        status.code += `(${cast}_get_trait_func(`;
        build_node(node.target, status);
        const trait_index = status.traits.indexOf(trait);
        const func_index = trait.functions.indexOf(trait_func);
        status.code += `, ${trait_index}, ${func_index}))(`;
        build_node(node.target, status);
        status.code += `)`;
      } else {
        // If the target is a struct, we need to convert the access function
        // into a C function that takes the struct as an argument
        status.code += `${c_type(type.name)}_${access_func.name}(`;
        if (!access_func.is_static) {
          // TODO: be more rigorous about this!
          if (type.name !== "int") {
            status.code += "&";
          }
          build_node(node.target, status);
        }
        for (let i = 0; i < access_func.params.length; i++) {
          if (!access_func.is_static || i > 0) {
            status.code += ", ";
          }
          build_node(access_func.params[i], status);
        }
        status.code += ")";
      }
      break;
    }
  }
}
