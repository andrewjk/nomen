import RootNode from "../nodes/RootNode.ts";
import build_block_node from "./build_block_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_root_node(node: RootNode, status: BuildStatus) {
	status.headers += `#include <stdint.h>\n`;
	status.code += `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include "main.h"

int malloc_count;

`.trimStart();

	build_block_node(node, status);

	// Apple ObjC framework imports (Foundation/Cocoa) pull in MacTypes.h, which
	// defines `Point`, `Rect`, etc. and would collide with user-defined types
	// of the same name. Only emit them when the generated code actually
	// references ObjC runtime symbols (e.g. GUI code via `objc_msgSend`).
	const needs_objc =
		/\bobjc_msgSend\b|\bobjc_getClass\b|\bsel_registerName\b/.test(status.code) ||
		/\bobjc_msgSend\b|\bobjc_getClass\b|\bsel_registerName\b/.test(status.headers);
	if (needs_objc && (status.platform === "macos" || status.platform === "ios")) {
		status.headers =
			`#import <Foundation/Foundation.h>\n` +
			`#include <objc/runtime.h>\n` +
			`#include <objc/message.h>\n` +
			(status.platform === "macos" ? `#import <Cocoa/Cocoa.h>\n` : `#import <UIKit/UIKit.h>\n`) +
			status.headers;
	}

	status.headers += "void **_get_trait_func(void **obj, int trait_index, int func_index);\n";
	status.code += `
void **_get_trait_func(void **obj, int trait_index, int func_index)
{
    void **vt = *obj;
    void **trait = *(vt + trait_index);
    void **func = *(trait + func_index);
    return func;
}  
`;

	for (let length of status.interpolate_string_counts) {
		let range = Array.from({ length }, (_, i) => i);
		let declaration = `char *_string_interpolate_${length}(char *pattern, ${range.map((n) => `char *arg${n + 1}`).join(", ")})`;
		status.headers += `${declaration};\n`;
		status.code += `${declaration}
{
    int length = snprintf(NULL, 0, pattern, ${range.map((n) => `arg${n + 1}`).join(", ")});
    char *str = malloc(length + 1);
    malloc_count++;
    snprintf(str, length + 1, pattern, ${range.map((n) => `arg${n + 1}`).join(", ")});
    return str;
}
`;
	}
}
