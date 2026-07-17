#pragma STDC FP_CONTRACT OFF
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>
#include <sys/types.h>
#include "main.h"

typedef struct Console
{
void *_vt;
} Console;
// Trait Disposable
typedef struct Disposable
{
} Disposable;
void Disposable_dispose(struct Disposable *self)
{
struct Disposable _self = *self;
Console_write("\nboom!");
}

// Trait Stringable
typedef struct Stringable
{
} Stringable;
char* Stringable_to_string(struct Stringable *self)
{
struct Stringable _self = *self;
char* _return_val = "";
return _return_val;
;
}

// Enum Result
Result Result_ok_init()
{
Result r;
r.tag = Result_ok;
return r;
}
Result Result_error_init(long code)
{
Result r;
r.tag = Result_error;
r._data._error.code = code;
return r;
}

// Struct int
char* int_to_string(long self)
{
int length = snprintf(NULL, 0, "%ld", self);
char* str = malloc(length + 1);
snprintf(str, length + 1, "%ld", self);
return str;
}
long int_parse(char* s)
{
return atoi(s);
}

// Struct uint
char* uint_to_string(unsigned long self)
{
int length = snprintf(NULL, 0, "%ld", self);
char* str = malloc(length + 1);
snprintf(str, length + 1, "%ld", self);
return str;
}

// Struct int8
char* int8_to_string(char self)
{
int length = snprintf(NULL, 0, "%d", self);
char* str = malloc(length + 1);
snprintf(str, length + 1, "%d", self);
return str;
}

// Struct uint8
char* uint8_to_string(unsigned char self)
{
int length = snprintf(NULL, 0, "%d", self);
char* str = malloc(length + 1);
snprintf(str, length + 1, "%d", self);
return str;
}

// Struct float
char* float_to_string(double self)
{
int length = snprintf(NULL, 0, "%f", self);
char* str = malloc(length + 1);
snprintf(str, length + 1, "%f", self);
return str;
}

// Struct char
char* char_to_string(char self)
{
int length = snprintf(NULL, 0, "%c", self);
char* str = malloc(length + 1);
snprintf(str, length + 1, "%c", self);
return str;
}

// Struct string
char* string_to_string(char* self)
{
return strdup(self);
}
char string_at(char* self, long index)
{
return self[index];
}
void string_set(char* *self, long index, char value)
{
(*self)[index] = value;
}
char* string_add(char* self, char* other)
{
int left_len = strlen(self);
int right_len = strlen(other);
char* result = malloc(left_len + right_len + 1);
strcpy(result, self);
strcat(result, other);
return result;
}
char* string_mul(char* self, long count)
{
int str_len = strlen(self);
int total = str_len * count + 1;
char* buf = malloc(total);
char* p = buf;
for (int i = 0; i < count; i++) {
memcpy(p, self, str_len);
p += str_len;
}
*p = 0;
return buf;
}

// Struct Console
Console Console_init()
{
Console c;
return c;
}
void Console_write(char* line)
{
printf("%s", line);
}
void Console_write_line(char* line)
{
printf("%s\n", line);
}
char* Console_read_line()
{
int cap = 16;
int len = 0;
char *buf = (char*)malloc(cap);
int c = getchar();
while (c != EOF && c != '\n') {
if (len + 1 >= cap) {
cap *= 2;
buf = (char*)realloc(buf, cap);
}
buf[len++] = (char)c;
c = getchar();
}
buf[len] = 0;
return buf;
char* _return_val = "";
return _return_val;
;
}
char Console_read_char()
{
return (char)getchar();
}
char* Console_platform()
{
return strdup("macos");
char* _return_val = "";
return _return_val;
;
}

// Struct bool
char* bool_to_string(unsigned char self)
{
int length = snprintf(NULL, 0, "%s", self ? "true" : "false");
char* str = malloc(length + 1);
snprintf(str, length + 1, "%s", self ? "true" : "false");
return str;
}

// Func main
int main()
{
Result result = Result_error_init(10L);
char* message;
if (result.tag == Result_ok) {
message = "it's ok";
} else if (result.tag == Result_error) {
long code = result._data._error.code;
message = "error 99 encountered";
}
Console_write(message);
long _return_val = 0L;
return _return_val;
;
}


void **_get_trait_func(void **obj, int trait_index, int func_index)
{
    void **vt = *obj;
    void **trait = *(vt + trait_index);
    void **func = *(trait + func_index);
    return func;
}  
