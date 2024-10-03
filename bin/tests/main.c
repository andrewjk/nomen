#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "standard.h"
#include "main.h"

int malloc_count;
// trait Disposable
typedef struct Disposable
{
} Disposable;
void Disposable_dispose(struct Disposable *self)
{
    struct Disposable _self = *self;
    Console_write("\nboom!");
}

// trait Stringable
typedef struct Stringable
{
} Stringable;

// trait Animal
typedef struct Animal
{
} Animal;
char *Animal_speak(struct Animal *self)
{
    struct Animal _self = *self;
    return "...";
}

// struct int
char *int_to_string(int self)
{
    int length = snprintf(NULL, 0, "%d", self);
    char *str = malloc(length + 1);
    malloc_count++;
    snprintf(str, length + 1, "%d", self);
    return str;
    return "0";
}

// struct string
char *string_to_string(char *self)
{
    return self;
    return "0";
}
void string_dispose(char *self)
{
    Console_write("\nboom string!");
    free(self);
    malloc_count--;
}

// struct Console
typedef struct Console
{
    void *_vt;
} Console;
Console Console_init()
{
    Console c;
    return c;
}
void Console_write(char *line)
{
    printf("%s", line);
}

// struct Dog
void *_Dog_Animal_funcs[] = {Dog_speak, get_Dog_name, set_Dog_name, get_Dog_age, set_Dog_age};
void *_Dog_Disposable_funcs[] = {Disposable_dispose};
void *_Dog_traits[] = {&_Dog_Disposable_funcs, NULL, &_Dog_Animal_funcs};
typedef struct Dog
{
    void *_vt;
    char *name;
    int age;
} Dog;
Dog Dog_init()
{
    Dog d;
    d._vt = &_Dog_traits;
    d.name = "Dog";
    d.age = 1;
    return d;
}
char *Dog_speak(struct Dog *self)
{
    struct Dog _self = *self;
    return "woof";
}
char *get_Dog_name(struct Dog *self) { return self->name; }
void set_Dog_name(struct Dog *self, char *value) { self->name = value; }
int get_Dog_age(struct Dog *self) { return self->age; }
void set_Dog_age(struct Dog *self, int value) { self->age = value; }

// struct Cat
void *_Cat_Animal_funcs[] = {Cat_speak, get_Cat_name, set_Cat_name, get_Cat_age, set_Cat_age};
void *_Cat_traits[] = {NULL, NULL, &_Cat_Animal_funcs};
typedef struct Cat
{
    void *_vt;
    char *name;
    int age;
} Cat;
Cat Cat_init()
{
    Cat c;
    c._vt = &_Cat_traits;
    c.name = "Cat";
    c.age = 1;
    return c;
}
char *Cat_speak(struct Cat *self)
{
    struct Cat _self = *self;
    return _self.name;
}
char *get_Cat_name(struct Cat *self) { return self->name; }
void set_Cat_name(struct Cat *self, char *value) { self->name = value; }
int get_Cat_age(struct Cat *self) { return self->age; }
void set_Cat_age(struct Cat *self, int value) { self->age = value; }

// struct Lizard
void *_Lizard_Animal_funcs[] = {Animal_speak, get_Lizard_name, set_Lizard_name, get_Lizard_age, set_Lizard_age};
void *_Lizard_traits[] = {NULL, NULL, &_Lizard_Animal_funcs};
typedef struct Lizard
{
    void *_vt;
    char *name;
    int age;
} Lizard;
Lizard Lizard_init()
{
    Lizard l;
    l._vt = &_Lizard_traits;
    l.name = "Lizard";
    l.age = 1;
    return l;
}
char *get_Lizard_name(struct Lizard *self) { return self->name; }
void set_Lizard_name(struct Lizard *self, char *value) { self->name = value; }
int get_Lizard_age(struct Lizard *self) { return self->age; }
void set_Lizard_age(struct Lizard *self, int value) { self->age = value; }

// func main
int main()
{
    Console_write("\n");
    int i;
    for (i = 0; i < 5; i++)
    {
        Console_write("hello, world! ");
        Console_write(int_to_string((i + 1)));
        int x = i + 1;
        if (x < 4)
        {
            Console_write(" is less than 4");
        }
        else
        {
            Console_write(" is 4 or more");
        }
        Console_write("\n");
    }
    Console_write("\n");
    int y = 0;
    while (y < 5)
    {
        Console_write("hi ");
        y = y + 1;
    }
    Console_write("\n\n");
    Dog dog = make_dog();
    ;
    Console_write(dog.name);
    Console_write(": ");
    Console_write(Dog_speak(&dog));
    Console_write("\n\n");
    Dog _animals_1 = Dog_init();
    Cat _animals_2 = Cat_init();
    Lizard _animals_3 = Lizard_init();
    void *animals[3] = {&_animals_1, &_animals_2, &_animals_3};
    for (int i = 0; i < 3; i++)
    {
        void *a = *(animals + i);
        Console_write(((char *(*)(void *))_get_trait_func(a, 2, 0))(a));
        Console_write("\n");
    }
    Cat cat = Cat_init();
    grow_animal((void *)&cat);
    ;
    Console_write("cat has age: ");
    Console_write(int_to_string(cat.age));

    ((void *(*)(void *))_get_trait_func((void *)&dog, 0, 0))(&dog);
    ((void *(*)(void *))_get_trait_func((void *)&_animals_1, 0, 0))(&_animals_1);

    printf("\n\nMalloc balance: %d\n", malloc_count);
}

// func make_dog
struct Dog make_dog()
{
    Dog dog = Dog_init();
    return dog;
}

// func grow_animal
void grow_animal(struct Animal *animal)
{
    ((void (*)(void *, int))_get_trait_func((void *)animal, 2, 4))(animal, ((int (*)(void *))_get_trait_func((void *)animal, 2, 3))(animal) + 1);
}
