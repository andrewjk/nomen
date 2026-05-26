// Trait Disposable
struct Disposable;
void Disposable_dispose(struct Disposable *self);

// Trait Stringable
struct Stringable;
char* Stringable_to_string(struct Stringable *self);

char* int_to_string(long self);
char* uint_to_string(unsigned long self);
char* int8_to_string(char self);
char* uint8_to_string(unsigned char self);
char* float_to_string(float self);
char* string_to_string(char* self);
// Struct Console
struct Console;
struct Console Console_init();
void Console_write(char* line);

// Func main
int main();

void **_get_trait_func(void **obj, int trait_index, int func_index);
char *_string_interpolate_3(char *pattern, char *arg1, char *arg2, char *arg3);
