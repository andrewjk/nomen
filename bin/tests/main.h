void **_get_trait_func(void **obj, int trait_index, int func_index);

// Animal:
struct Animal;
char* Animal_speak(struct Animal *self);

// Dog:
struct Dog;
struct Dog Dog_init();
char* Dog_speak(struct Dog *self);

// Cat:
struct Cat;
struct Cat Cat_init();
char* Cat_speak(struct Cat *self);

// Lizard:
struct Lizard;
struct Lizard Lizard_init();

