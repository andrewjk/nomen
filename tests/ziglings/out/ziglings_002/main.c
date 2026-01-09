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
Console_write("Standard Library.\n");

printf("\n\nMalloc balance: %d\n", malloc_count);
}


void **_get_trait_func(void **obj, int trait_index, int func_index)
{
    void **vt = *obj;
    void **trait = *(vt + trait_index);
    void **func = *(trait + func_index);
    return func;
}  
