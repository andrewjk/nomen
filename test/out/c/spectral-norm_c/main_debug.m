#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>
#include <sys/types.h>
#include "main.h"

int malloc_count;

typedef struct Console
{
void *_vt;
} Console;
typedef struct Init
{
void *_vt;
long argc;
char* args[16];
} Init;
typedef struct Math
{
void *_vt;
} Math;
typedef struct Array_string
{
void *_vt;
long length;
} Array_string;
typedef struct Buffer_float
{
void *_vt;
unsigned long long data;
long cap;
} Buffer_float;
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

// Struct int
char* int_to_string(long self)
{
int length = snprintf(NULL, 0, "%ld", self);
char* str = malloc(length + 1);
malloc_count++;
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
malloc_count++;
snprintf(str, length + 1, "%ld", self);
return str;
}

// Struct int8
char* int8_to_string(char self)
{
int length = snprintf(NULL, 0, "%d", self);
char* str = malloc(length + 1);
malloc_count++;
snprintf(str, length + 1, "%d", self);
return str;
}

// Struct uint8
char* uint8_to_string(unsigned char self)
{
int length = snprintf(NULL, 0, "%d", self);
char* str = malloc(length + 1);
malloc_count++;
snprintf(str, length + 1, "%d", self);
return str;
}

// Struct float
char* float_to_string(float self)
{
int length = snprintf(NULL, 0, "%f", self);
char* str = malloc(length + 1);
malloc_count++;
snprintf(str, length + 1, "%f", self);
return str;
}

// Struct char
char* char_to_string(char self)
{
int length = snprintf(NULL, 0, "%c", self);
char* str = malloc(length + 1);
malloc_count++;
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
malloc_count++;
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
malloc_count++;
snprintf(str, length + 1, "%s", self ? "true" : "false");
return str;
}

// Struct Init
Init Init_init(long argc, char* *args)
{
Init i;
i.argc = argc;
memcpy(i.args, args, sizeof(i.args));
return i;
}

// Struct Math
Math Math_init()
{
Math m;
return m;
}
long Math_power(long base, long exp)
{
int result = 1;
for (int i = 0; i < exp; i++) {
result *= base;
}
return result;
}
float Math_sqrt(float x)
{
}
float Math_log(float x)
{
return log(x);
}

// Struct Array_string
Array_string Array_string_init(long length)
{
Array_string a;
a.length = length;
return a;
}
char* Array_string_at(struct Array_string *self, long index)
{
struct Array_string _self = *self;
char** _data = (char**)((char*)self + sizeof(*self));
return _data[index];
}
char* Array_string_first(struct Array_string *self)
{
struct Array_string _self = *self;
char** _data = (char**)((char*)self + sizeof(*self));
return _data[0];
}
void Array_string_set(struct Array_string *self, long index, char* value)
{
char** _data = (char**)((char*)self + sizeof(*self));
_data[index] = value;
}
char* Array_string_at_end(struct Array_string *self)
{
struct Array_string _self = *self;
char** _data = (char**)((char*)self + sizeof(*self));
return _data[self->length - 1];
}
void* Array_string_with(char* value, long count)
{
long _header = 16;
void* _result = malloc(_header + count * 8);
((long*)_result)[1] = count;
char** _data = (char**)((char*)_result + _header);
for (long i = 0; i < count; i++) {
_data[i] = value;
}
return _result;
}
struct Array_string Array_string_add(struct Array_string *self, struct Array_string *other)
{
struct Array_string _self = *self;
typeof(*self) _result;
_result.length = _self.length + other->length;
char** self_data = (char**)(self + 1);
char** other_data = (char**)(other + 1);
return _result;
}
struct Array_string Array_string_mul(struct Array_string *self, long other)
{
struct Array_string _self = *self;
typeof(*self) _result;
_result.length = _self.length * other;
return _result;
}

// Struct Buffer_float
Buffer_float Buffer_float_init()
{
Buffer_float b;
b.data = 0;
b.cap = 0;
return b;
}
long Buffer_float_alloc(struct Buffer_float *self, long size)
{
self->cap = size;
self->data = (unsigned long long)(unsigned int*)calloc(size, sizeof(unsigned int));
return self->cap;
}
long Buffer_float_grow(struct Buffer_float *self, long needed)
{
if (self->cap >= needed) return self->cap;
int new_cap = self->cap;
if (new_cap == 0) new_cap = 8;
while (new_cap < needed) new_cap *= 2;
self->data = (unsigned long long)(unsigned int*)realloc((unsigned int*)(unsigned long long)self->data, new_cap * sizeof(unsigned int));
memset((unsigned int*)(unsigned long long)self->data + self->cap, 0, (new_cap - self->cap) * sizeof(unsigned int));
self->cap = new_cap;
return self->cap;
}
void Buffer_float_zero(struct Buffer_float *self, long len)
{
memset((unsigned int*)(unsigned long long)self->data, 0, len * sizeof(unsigned int));
}
unsigned int Buffer_float_load(struct Buffer_float *self, long i)
{
struct Buffer_float _self = *self;
return ((unsigned int*)(unsigned long long)self->data)[i];
}
void Buffer_float_store(struct Buffer_float *self, long i, unsigned int val)
{
((unsigned int*)(unsigned long long)self->data)[i] = val;
}
void Buffer_float_store_or(struct Buffer_float *self, long i, unsigned int val)
{
((unsigned int*)(unsigned long long)self->data)[i] |= val;
}
long Buffer_float_alloc_int(struct Buffer_float *self, long size)
{
self->cap = size;
self->data = (unsigned long long)(long*)calloc(size, sizeof(long));
return self->cap;
}
long Buffer_float_grow_int(struct Buffer_float *self, long needed)
{
if (self->cap >= needed) return self->cap;
int new_cap = self->cap;
if (new_cap == 0) new_cap = 4;
while (new_cap < needed) new_cap *= 2;
self->data = (unsigned long long)(long*)realloc((long*)(unsigned long long)self->data, new_cap * sizeof(long));
memset((long*)(unsigned long long)self->data + self->cap, 0, (new_cap - self->cap) * sizeof(long));
self->cap = new_cap;
return self->cap;
}
long Buffer_float_load_int(struct Buffer_float *self, long i)
{
struct Buffer_float _self = *self;
return ((long*)(unsigned long long)self->data)[i];
}
void Buffer_float_store_int(struct Buffer_float *self, long i, long val)
{
((long*)(unsigned long long)self->data)[i] = val;
}
long Buffer_float_move_int(struct Buffer_float *self, long i)
{
long *slots = (long*)(unsigned long long)self->data;
long val = slots[i];
slots[i] = 0;
return val;
}
void Buffer_float_replace_int(struct Buffer_float *self, long i, long val)
{
((long*)(unsigned long long)self->data)[i] = val;
}
void Buffer_float_zero_int(struct Buffer_float *self, long len)
{
memset((long*)(unsigned long long)self->data, 0, len * sizeof(long));
}
long Buffer_float_alloc_T(struct Buffer_float *self, long size)
{
self->cap = size;
self->data = (unsigned long long)(float*)calloc(size, 8);
return self->cap;
}
long Buffer_float_grow_T(struct Buffer_float *self, long needed)
{
if (self->cap >= needed) return self->cap;
int new_cap = self->cap;
if (new_cap == 0) new_cap = 4;
while (new_cap < needed) new_cap *= 2;
self->data = (unsigned long long)(float*)realloc((float*)(unsigned long long)self->data, new_cap * 8);
memset((char*)(unsigned long long)self->data + self->cap * 8, 0, (new_cap - self->cap) * 8);
self->cap = new_cap;
return self->cap;
}
float Buffer_float_load_T(struct Buffer_float *self, long i)
{
struct Buffer_float _self = *self;
return ((float*)(unsigned long long)self->data)[i];
}
void Buffer_float_store_T(struct Buffer_float *self, long i, float val)
{
((float*)(unsigned long long)self->data)[i] = val;
}
void Buffer_float_zero_T(struct Buffer_float *self, long len)
{
memset((float*)(unsigned long long)self->data, 0, len * 8);
}
void Buffer_float_store_or_int(struct Buffer_float *self, long i, long val)
{
((long*)(unsigned long long)self->data)[i] |= val;
}
long Buffer_float_alloc_float(struct Buffer_float *self, long size)
{
self->cap = size;
self->data = (unsigned long long)(double*)calloc(size, sizeof(double));
return self->cap;
}
float Buffer_float_load_float(struct Buffer_float *self, long i)
{
struct Buffer_float _self = *self;
return ((double*)(unsigned long long)self->data)[i];
}
void Buffer_float_store_float(struct Buffer_float *self, long i, float val)
{
((double*)(unsigned long long)self->data)[i] = val;
}
void Buffer_float_destroy(struct Buffer_float *self)
{
struct Buffer_float _self = *self;
if (self->data) free((unsigned int*)(unsigned long long)self->data);
self->data = 0;
self->cap = 0;
}

// Func eval_a_times_u
void eval_a_times_u(struct Buffer_float *au, struct Buffer_float *u, long n, unsigned char transpose)
{
long i = 0;
while ((i < n)) {
float a = 0.0;
long j = 0;
long denom = ((i * ((i + 1))) / 2);
if (transpose) {
denom = (denom + 1);
} else {
denom = ((denom + i) + 1);
}
while ((j < n)) {
a = (a + (((1.0 / ((float)denom))) * Buffer_float_load_float(u, j)));
if (transpose) {
denom = (((denom + i) + j) + 2);
} else {
denom = (((denom + i) + j) + 1);
}
j = (j + 1);
}
Buffer_float_store_float(au, i, a);
i = (i + 1);
}
}

// Func eval_ata_times_u
void eval_ata_times_u(struct Buffer_float *atau, struct Buffer_float *u, struct Buffer_float *scratch, long n)
{
eval_a_times_u(scratch, u, n, 0);
eval_a_times_u(atau, scratch, n, 1);
}

// Func main
int main(int argc, char **argv)
{
struct Init _echo_init_data;
struct Init *init = &_echo_init_data;
init->_vt = 0;
init->argc = argc;
for (int _echo_i = 0; _echo_i < argc && _echo_i < 16; _echo_i++) init->args[_echo_i] = argv[_echo_i];
long n = 100;
if ((init->argc > 1)) {
char* _param_0 = (init->args[1]);
n = parse_int(_param_0);

// Auto-free
free(_param_0);
malloc_count--;
}
struct Buffer_float u = Buffer_float_init();
struct Buffer_float v = Buffer_float_init();
struct Buffer_float scratch = Buffer_float_init();
Buffer_float_alloc_float(&u, n);
Buffer_float_alloc_float(&v, n);
Buffer_float_alloc_float(&scratch, n);
long i = 0;
while ((i < n)) {
Buffer_float_store_float(&u, i, 1.0);
Buffer_float_store_float(&v, i, 1.0);
i = (i + 1);
}
i = 0;
while ((i < 10)) {
eval_ata_times_u(&v, &u, &scratch, n);
eval_ata_times_u(&u, &v, &scratch, n);
i = (i + 1);
}
float vbv = 0.0;
float vv = 0.0;
i = 0;
while ((i < n)) {
vbv = (vbv + (Buffer_float_load_float(&u, i) * Buffer_float_load_float(&v, i)));
vv = (vv + (Buffer_float_load_float(&v, i) * Buffer_float_load_float(&v, i)));
i = (i + 1);
}
float _param_1 = (vbv / vv);
float result = Math_sqrt(_param_1);
char* _param_2 = float_to_string(result);
Console_write(_param_2);
Console_write("\n");

// Auto-free
Buffer_float_destroy(&u);
Buffer_float_destroy(&v);
Buffer_float_destroy(&scratch);
free(_param_2);
malloc_count--;

printf("\n\nMalloc balance: %d\n", malloc_count);
}

// Func parse_int
long parse_int(char* s)
{
return atoi(s);
}


void **_get_trait_func(void **obj, int trait_index, int func_index)
{
    void **vt = *obj;
    void **trait = *(vt + trait_index);
    void **func = *(trait + func_index);
    return func;
}  
