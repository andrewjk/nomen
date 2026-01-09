#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

int malloc_count;

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

// Struct int
char* int_to_string(long self)
{
int length = snprintf(NULL, 0, "%ld", self);
char* str = malloc(length + 1);
malloc_count++;
snprintf(str, length + 1, "%ld", self);
return str;
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

// Struct string
char* string_to_string(char* self)
{
return self;
}

// Struct Console
typedef struct Console
{
void *_vt;
} Console;
Console Console_init()
{
Console c;
return c;
}
void Console_write(char* line)
{
printf("%s", line);
}

// Func main
int main()
{
unsigned char n = 50;
n = n + 5;
float pi = 3.14159;
char negative_eleven = -11;
char* _param_0 = uint8_to_string(n);
char* _param_1 = float_to_string(pi);
char* _param_2 = int8_to_string(negative_eleven);
char* _param_3 = _string_interpolate_3("%s %s %s\n", _param_0, _param_1, _param_2);
Console_write(_param_3);

// Auto-free
free(_param_0);
malloc_count--;
free(_param_1);
malloc_count--;
free(_param_2);
malloc_count--;
free(_param_3);
malloc_count--;

printf("\n\nMalloc balance: %d\n", malloc_count);
}


void **_get_trait_func(void **obj, int trait_index, int func_index)
{
    void **vt = *obj;
    void **trait = *(vt + trait_index);
    void **func = *(trait + func_index);
    return func;
}  
char *_string_interpolate_3(char *pattern, char *arg1, char *arg2, char *arg3)
{
    int length = snprintf(NULL, 0, pattern, arg1, arg2, arg3);
    char *str = malloc(length + 1);
    malloc_count++;
    snprintf(str, length + 1, pattern, arg1, arg2, arg3);
    return str;
}
