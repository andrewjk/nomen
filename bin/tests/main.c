#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "standard.h"
#include "main.h"

// trait Disposable
typedef struct Disposable
{
} Disposable;
void Disposable_dispose()
{
    printf("%s", "\nboom!");
}

// trait Animal
typedef struct Animal
{
} Animal;
char *Animal_speak(struct Animal *self)
{
    struct Animal _self = *self;
    return "...";
}

// struct Dog
void *_Dog_Animal_funcs[] = {Dog_speak, get_Dog_name, set_Dog_name, get_Dog_age, set_Dog_age};
void *_Dog_Disposable_funcs[] = {Disposable_dispose};
void *_Dog_traits[] = {&_Dog_Disposable_funcs, &_Dog_Animal_funcs};
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
void *_Cat_traits[] = {NULL, &_Cat_Animal_funcs};
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
void *_Lizard_traits[] = {NULL, &_Lizard_Animal_funcs};
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
    printf("%s", "\n");
    int i;
    for (i = 0; i < 5; i++)
    {
        printf("%s", "hello, world! ");
        printf("%d", i + 1);
        int x = i + 1;
        if (x < 4)
        {
            printf("%s", " is less than 4");
        }
        else
        {
            printf("%s", " is 4 or more");
        }
        printf("%s", "\n");
    }
    printf("%s", "\n");
    int y = 0;
    while (y < 5)
    {
        printf("%s", "hi ");
        y = y + 1;
    }
    printf("%s", "\n\n");
    Dog dog = make_dog();
    ;
    printf("%s", dog.name);
    printf("%s", ": ");
    printf("%s", Dog_speak(&dog));
    printf("%s", "\n\n");
    Dog _animals_1 = Dog_init();
    Cat _animals_2 = Cat_init();
    Lizard _animals_3 = Lizard_init();
    void *animals[3] = {&_animals_1, &_animals_2, &_animals_3};
    for (int i = 0; i < 3; i++)
    {
        void *a = *(animals + i);
        printf("%s", ((char *(*)(void *))_get_trait_func(a, 1, 0))(a));
        printf("%s", "\n");
    }
    Cat cat = Cat_init();
    grow_animal((void *)&cat);
    printf("%s", "cat has age: ");
    printf("%d", cat.age);

    ((void *(*)(void *))_get_trait_func((void *)&dog, 0, 0))(&dog);
    ((void *(*)(void *))_get_trait_func((void *)&_animals_1, 0, 0))(&_animals_1);
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
    ((void (*)(void *, int))_get_trait_func((void *)animal, 1, 4))(animal, ((int (*)(void *))_get_trait_func((void *)animal, 1, 3))(animal) + 1);
}
