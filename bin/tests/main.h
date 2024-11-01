// Trait Disposable
struct Disposable;
void Disposable_dispose(struct Disposable *self);

// Trait Stringable
struct Stringable;

// Trait Animal
struct Animal;
char* Animal_speak(struct Animal *self);

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

// Struct Dog
struct Dog;
struct Dog Dog_init();
char* Dog_speak(struct Dog *self);
char* get_Dog_name(struct Dog *self);
void set_Dog_name(struct Dog *self, char* value);
long get_Dog_age(struct Dog *self);
void set_Dog_age(struct Dog *self, long value);

// Struct Cat
struct Cat;
struct Cat Cat_init();
char* Cat_speak(struct Cat *self);
char* get_Cat_name(struct Cat *self);
void set_Cat_name(struct Cat *self, char* value);
long get_Cat_age(struct Cat *self);
void set_Cat_age(struct Cat *self, long value);

// Struct Lizard
struct Lizard;
struct Lizard Lizard_init();
char* get_Lizard_name(struct Lizard *self);
void set_Lizard_name(struct Lizard *self, char* value);
long get_Lizard_age(struct Lizard *self);
void set_Lizard_age(struct Lizard *self, long value);

// Func main
int main();

// Func make_dog
struct Dog make_dog();

// Func grow_animal
void grow_animal(struct Animal *animal);

void **_get_trait_func(void **obj, int trait_index, int func_index);
char *_string_interpolate_1(char *pattern, char *arg1);
