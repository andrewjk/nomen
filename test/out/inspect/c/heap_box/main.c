typedef struct { void* ptr; long len; } nomen_view;
#pragma STDC FP_CONTRACT OFF
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include "main.h"

typedef struct Console
{
void *_vt;
} Console;
typedef struct Array_Box
{
void *_vt;
long length;
} Array_Box;
// Trait Stringable
typedef struct Stringable
{
} Stringable;
char* Stringable_to_string(struct Stringable *self)
{
struct Stringable _self = *self;
char* _return_val = nomen_strdup_wrap("");
return _return_val;
;
}

// Trait Equatable
typedef struct Equatable
{
} Equatable;

// Trait Hashable
typedef struct Hashable
{
} Hashable;
unsigned long Hashable_hash(struct Hashable *self)
{
struct Hashable _self = *self;
long _return_val = 0L;
return _return_val;
;
}

// Trait Disposable
typedef struct Disposable
{
} Disposable;
void Disposable_dispose(struct Disposable *self)
{
struct Disposable _self = *self;
Console_write("\nboom!");
}

// Trait Viewable
typedef struct Viewable
{
} Viewable;

// Struct uint
unsigned long uint_hash(unsigned long self)
{
return (unsigned long)self;
}
char* uint_to_string(unsigned long self)
{
int length = snprintf(NULL, 0, "%ld", self);
char* str = nomen_malloc_wrap(length + 1);
snprintf(str, length + 1, "%ld", self);
return str;
}

// Struct int
unsigned long int_hash(long self)
{
return (unsigned long)self;
}
char* int_to_string(long self)
{
int length = snprintf(NULL, 0, "%ld", self);
char* str = nomen_malloc_wrap(length + 1);
snprintf(str, length + 1, "%ld", self);
return str;
}
long int_parse(char* s)
{
return atoi(s);
}

// Struct char
unsigned long char_hash(char self)
{
return (unsigned long)self;
}
char* char_to_string(char self)
{
int length = snprintf(NULL, 0, "%c", self);
char* str = nomen_malloc_wrap(length + 1);
snprintf(str, length + 1, "%c", self);
return str;
}

// Struct bool
unsigned long bool_hash(unsigned char self)
{
return (unsigned long)self;
}
char* bool_to_string(unsigned char self)
{
int length = snprintf(NULL, 0, "%s", self ? "true" : "false");
char* str = nomen_malloc_wrap(length + 1);
snprintf(str, length + 1, "%s", self ? "true" : "false");
return str;
}

// Struct string
unsigned long string_hash(char* self)
{
unsigned long h = 5381;
for (const char* p = self; *p; p++) {
h = h * 33 + (unsigned long)(unsigned char)*p;
}
return h;
}
char* string_to_string(char* self)
{
return nomen_strdup_wrap(self);
}
char string_at(char* self, long index)
{
return self[index];
}
nomen_view string_slice(char* self, long start, long end)
{
nomen_view _r;
_r.ptr = (void*)(self + start);
_r.len = (long)(end - start);
return _r;
}
void string_set(char* *self, long index, char value)
{
(*self)[index] = value;
}
unsigned char string_eq(char* self, char* other)
{
return strcmp(self, other) == 0;
}
char* string_add(char* self, char* other)
{
int left_len = strlen(self);
int right_len = strlen(other);
char* result = nomen_malloc_wrap(left_len + right_len + 1);
strcpy(result, self);
strcat(result, other);
return result;
}
char* string_mul(char* self, long count)
{
size_t str_len = strlen(self);
size_t total = str_len * (size_t)count + 1;
char* buf = nomen_malloc_wrap(total);
char* p = buf;
for (int i = 0; i < count; i++) {
memcpy(p, self, str_len);
p += str_len;
}
*p = 0;
return buf;
}

// Struct Console
struct Console Console_init()
{
struct Console _self;
return _self;
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
char *buf = (char*)nomen_malloc_wrap(cap);
int c = getchar();
while (c != EOF && c != '\n') {
if (len + 2 > cap) {
cap *= 2;
buf = (char*)nomen_realloc_wrap(buf, cap);
}
buf[len++] = (char)c;
c = getchar();
}
buf[len] = 0;
return buf;
char* _return_val = nomen_strdup_wrap("");
return _return_val;
;
}
char Console_read_char()
{
return (char)getchar();
}
char* Console_platform()
{
return nomen_strdup_wrap("macos");
char* _return_val = nomen_strdup_wrap("");
return _return_val;
;
}

// Struct int8
unsigned long int8_hash(char self)
{
return (unsigned long)self;
}
char* int8_to_string(char self)
{
int length = snprintf(NULL, 0, "%d", self);
char* str = nomen_malloc_wrap(length + 1);
snprintf(str, length + 1, "%d", self);
return str;
}

// Struct uint8
unsigned long uint8_hash(unsigned char self)
{
return (unsigned long)self;
}
char* uint8_to_string(unsigned char self)
{
int length = snprintf(NULL, 0, "%d", self);
char* str = nomen_malloc_wrap(length + 1);
snprintf(str, length + 1, "%d", self);
return str;
}

// Struct float
char* float_to_string(double self)
{
int length = snprintf(NULL, 0, "%f", self);
char* str = nomen_malloc_wrap(length + 1);
snprintf(str, length + 1, "%f", self);
return str;
}

// Struct Array_Box
void *_Array_Box_Viewable_funcs[] = {};
void *_Array_Box_traits[] = {NULL, NULL, NULL, NULL, NULL, &_Array_Box_Viewable_funcs};
struct Array_Box Array_Box_init(long length)
{
struct Array_Box _self;
_self._vt = &_Array_Box_traits;
_self.length = length;
return _self;
}
struct Box* Array_Box_at(struct Array_Box *self, long index)
{
struct Array_Box _self = *self;
struct Box ** _data = (struct Box **)((char*)self + sizeof(*self));
return _data[index];
}
struct Box* Array_Box_first(struct Array_Box *self)
{
struct Array_Box _self = *self;
struct Box ** _data = (struct Box **)((char*)self + sizeof(*self));
return _data[0];
}
void Array_Box_set(struct Array_Box *self, long index, struct Box *value)
{
struct Box ** _data = (struct Box **)((char*)self + sizeof(*self));
// 0 is 1 when struct Box * is string: the slot must own a heap copy
// (free the outgoing string, strdup the incoming one) so auto_free can
// soundly free every slot at scope exit and reassigning a slot doesn't
// leak the previous value. 0 for all other struct Box * (plain assignment).
#if 0
nomen_free_wrap(_data[index]);
_data[index] = (struct Box *)nomen_strdup_wrap(value);
#else
_data[index] = value;
#endif
}
struct Box* Array_Box_at_end(struct Array_Box *self)
{
struct Array_Box _self = *self;
struct Box ** _data = (struct Box **)((char*)self + sizeof(*self));
return _data[self->length - 1];
}
nomen_view Array_Box_slice(struct Array_Box *self, long start, long end)
{
struct Array_Box _self = *self;
nomen_view _r;
struct Box ** _data = (struct Box **)((char*)self + sizeof(*self));
_r.ptr = (void*)(_data + start);
_r.len = (long)(end - start);
return _r;
}
void* Array_Box_with(struct Box *value, long count)
{
long _header = 16;
void* _result = nomen_malloc_wrap(_header + count * 8);
((long*)_result)[1] = count;
struct Box ** _data = (struct Box **)((char*)_result + _header);
for (long i = 0; i < count; i++) {
// 0 is 1 when struct Box * is string (a `char*` pointer whose
// backing bytes must be heap-copied per slot — otherwise all n
// slots would share one pointer and auto_free would n-free it).
// For all other struct Box * it is 0 and the plain assignment runs.
#if 0
_data[i] = (struct Box *)nomen_strdup_wrap(value);
#else
_data[i] = value;
#endif
}
return _result;
}
void* Array_Box_add(struct Array_Box *self, struct Array_Box *other)
{
struct Array_Box _self = *self;
long _self_len = self->length;
long _other_len = other->length;
long _result_len = _self_len + _other_len;
long _header = sizeof(*self);
void* _result = nomen_malloc_wrap(_header + _result_len * 8);
((long*)_result)[0] = 0;
((long*)_result)[1] = _result_len;
struct Box ** _data = (struct Box **)((char*)_result + _header);
struct Box ** self_data = (struct Box **)((char*)self + _header);
struct Box ** other_data = (struct Box **)((char*)other + _header);
memcpy(_data, self_data, _self_len * 8);
memcpy(_data + _self_len, other_data, _other_len * 8);
return _result;
}
void* Array_Box_mul(struct Array_Box *self, long other)
{
struct Array_Box _self = *self;
long _self_len = self->length;
long _result_len = _self_len * other;
long _header = sizeof(*self);
void* _result = nomen_malloc_wrap(_header + _result_len * 8);
((long*)_result)[0] = 0;
((long*)_result)[1] = _result_len;
struct Box ** _data = (struct Box **)((char*)_result + _header);
struct Box ** self_data = (struct Box **)((char*)self + _header);
for (long i = 0; i < other; i++) {
memcpy(_data + i * _self_len, self_data, _self_len * 8);
}
return _result;
}

typedef struct Box
{
void *_vt;
long value;
} Box;
// Struct Box
struct Box* Box_init(long value)
{
struct Box* _self = nomen_malloc_wrap(sizeof(struct Box));
_self->value = value;
return _self;
}
void Box_destroy(struct Box *self)
{
}

// Func main
int main()
{
struct Array_Box* v;
v = nomen_malloc_wrap(sizeof(struct Array_Box) + 2L * sizeof(struct Box*));
v->_vt = 0;
v->length = 2L;
memcpy((char *)v + sizeof(struct Array_Box), (struct Box*[]){Box_init(7L), Box_init(8L)}, 2L * sizeof(struct Box*));
;
long total = 0L;
{
long __for_idx_b;
for (__for_idx_b = 0L; __for_idx_b < v->length; __for_idx_b++)
{
struct Box *b = Array_Box_at(v, __for_idx_b);
total = (total + b->value);
}
}
char* _param_0 = int_to_string(total);
char* _param_1 = _string_interpolate_1("%s", _param_0);
Console_write(_param_1);

// Auto-free
for (long _i = 0; _i < v->length; _i++) {
	struct Box** _data = (struct Box**)((char*)v + sizeof(struct Array_Box));
	Box_destroy(_data[_i]); nomen_free_wrap(_data[_i]);
}
nomen_free_wrap(v);
nomen_free_wrap(_param_0);
nomen_free_wrap(_param_1);

nomen_audit_check();
return 0;
}


void **_get_trait_func(void **obj, int trait_index, int func_index)
{
    void **vt = *obj;
    // Slot 0 of _<Struct>_traits is the destroy-funcs pointer (reserved so a
    // trait-typed collection can dispatch destroy polymorphically). Real trait
    // tables start at index 1, so shift trait_index by 1.
    void **trait = *(vt + 1 + trait_index);
    void **func = *(trait + func_index);
    return func;
}  
void Stringable_destroy(void *obj)
{
    void **vt = *(void **)obj;
    void **destroy_funcs = (void **)vt[0];
    if (destroy_funcs) {
        void (*destroy)(void *) = (void (*)(void *))*destroy_funcs;
        if (destroy) destroy(obj);
    }
}
void Equatable_destroy(void *obj)
{
    void **vt = *(void **)obj;
    void **destroy_funcs = (void **)vt[0];
    if (destroy_funcs) {
        void (*destroy)(void *) = (void (*)(void *))*destroy_funcs;
        if (destroy) destroy(obj);
    }
}
void Hashable_destroy(void *obj)
{
    void **vt = *(void **)obj;
    void **destroy_funcs = (void **)vt[0];
    if (destroy_funcs) {
        void (*destroy)(void *) = (void (*)(void *))*destroy_funcs;
        if (destroy) destroy(obj);
    }
}
void Disposable_destroy(void *obj)
{
    void **vt = *(void **)obj;
    void **destroy_funcs = (void **)vt[0];
    if (destroy_funcs) {
        void (*destroy)(void *) = (void (*)(void *))*destroy_funcs;
        if (destroy) destroy(obj);
    }
}
void Viewable_destroy(void *obj)
{
    void **vt = *(void **)obj;
    void **destroy_funcs = (void **)vt[0];
    if (destroy_funcs) {
        void (*destroy)(void *) = (void (*)(void *))*destroy_funcs;
        if (destroy) destroy(obj);
    }
}
char *_string_interpolate_1(char *pattern, char *arg1)
{
    int length = snprintf(NULL, 0, pattern, arg1);
    char *str = nomen_malloc_wrap(length + 1);
    snprintf(str, length + 1, pattern, arg1);
    return str;
}
