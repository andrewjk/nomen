// trait Disposable
struct Disposable;
void Disposable_dispose(struct Disposable *self);

// trait Stringable
struct Stringable;

// trait Animal
struct Animal;
char* Animal_speak(struct Animal *self);

char* int_to_string(int self);
char* string_to_string(char* self);
void string_dispose(char* self);
// struct Console
struct Console;
struct Console Console_init();
void Console_write(char* line);

// struct Dog
struct Dog;
struct Dog Dog_init();
char* Dog_speak(struct Dog *self);
char* get_Dog_name(struct Dog *self);
void set_Dog_name(struct Dog *self, char* value);
int get_Dog_age(struct Dog *self);
void set_Dog_age(struct Dog *self, int value);

// struct Cat
struct Cat;
struct Cat Cat_init();
char* Cat_speak(struct Cat *self);
char* get_Cat_name(struct Cat *self);
void set_Cat_name(struct Cat *self, char* value);
int get_Cat_age(struct Cat *self);
void set_Cat_age(struct Cat *self, int value);

// struct Lizard
struct Lizard;
struct Lizard Lizard_init();
char* get_Lizard_name(struct Lizard *self);
void set_Lizard_name(struct Lizard *self, char* value);
int get_Lizard_age(struct Lizard *self);
void set_Lizard_age(struct Lizard *self, int value);

// func main
int main();

// func make_dog
struct Dog make_dog();

// func grow_animal
void grow_animal(struct Animal *animal);

