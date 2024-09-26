import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessFunctionNode from "../nodes/AccessFunctionNode";
import AccessNode from "../nodes/AccessNode";
import FunctionNode from "../nodes/FunctionNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import c_type from "./utils/c_type";
import type_from_value_node from "./utils/type_from_value_node";

export default function build_access_node(node: AccessNode, status: BuildStatus) {
  // PERF:
  const type = type_from_value_node(node.source);
  const trait = status.traits.find((t) => t.name === type.name);

  switch (node.access.node_type) {
    case "access_field": {
      const field = node.access as AccessFieldNode;
      if (trait) {
        // If the target is a trait, we need to call the get/set method
        const traitField = trait.fields.find((f) => f.name == field.name)!;
        // TODO: Cast to the correct function definition
        // TODO: Use the correct variable name
        // TODO: Pass parameters
        const type = c_type(traitField.type.name);
        const cast = `(${type}(*)(void *))`;
        status.code += `(${cast}_get_trait_func((void *)`;
        build_node(node.source, status);
        const traitIndex = status.traits.indexOf(trait);
        const fieldIndex = trait.functions.length + trait.fields.indexOf(traitField) * 2;
        status.code += `, ${traitIndex}, ${fieldIndex}))(`;
        build_node(node.source, status);
        status.code += `)`;
        break;
      } else {
        // If the target is a struct, we can just access the field directly
        build_node(node.source, status);
        status.code += `.${node.access.name}`;
      }
      break;
    }
    case "access_func": {
      const func = node.access as AccessFunctionNode;
      if (trait) {
        // If the target is a trait, we need to find the correct function to
        // call from the vtable
        const traitFunc = trait.functions.find((f) => f.name == func.name)!;
        // TODO: Cast to the correct function definition
        // TODO: Use the correct variable name
        // TODO: Pass parameters
        const cast = "(char *(*)(void *))";
        status.code += `(${cast}_get_trait_func(`;
        build_node(node.source, status);
        const traitIndex = status.traits.indexOf(trait);
        const funcIndex = trait.functions.indexOf(traitFunc);
        status.code += `, ${traitIndex}, ${funcIndex}))(`;
        build_node(node.source, status);
        status.code += `)`;
      } else {
        // If the target is a struct, we need to convert the access function
        // into a C function that takes the struct as an argument
        status.code += `${c_type(type.name)}_${func.name}(`;
        if (!func.static) {
          status.code += "&";
          build_node(node.source, status);
        }
        for (let i = 0; i < func.params.length; i++) {
          if (!func.static || i > 0) {
            status.code += ", ";
          }
          build_node(func.params[i], status);
        }
        status.code += ")";
      }
      break;
    }
  }
}
