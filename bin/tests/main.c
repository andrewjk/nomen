#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

void **_get_trait_func(void **obj, int trait_index, int func_index)
{
void **trait = *(obj + trait_index);
return *(trait + func_index);
}

// Animal:
typedef struct Animal
{
} Animal;
char* Animal_speak(struct Animal *self)
{
struct Animal zz = *self;
return "...";
}

// Dog:
void *_Dog_Animal_funcs[] = {Dog_speak};
void *_Dog_traits[] = {_Dog_Animal_funcs};
typedef struct Dog
{
void *_vt;
char* name;
} Dog;
Dog Dog_init()
{
Dog d;
d._vt = &_Dog_traits;
d.name = "Dog";
return d;
}
char* Dog_speak(struct Dog *self)
{
struct Dog zz = *self;
return "woof";
}

// Cat:
void *_Cat_Animal_funcs[] = {Cat_speak};
void *_Cat_traits[] = {_Cat_Animal_funcs};
typedef struct Cat
{
void *_vt;
char* name;
} Cat;
Cat Cat_init()
{
Cat c;
c._vt = &_Cat_traits;
c.name = "Cat";
return c;
}
char* Cat_speak(struct Cat *self)
{
struct Cat zz = *self;
return zz.name;
}

// Lizard:
void *_Lizard_Animal_funcs[] = {Animal_speak};
void *_Lizard_traits[] = {_Lizard_Animal_funcs};
typedef struct Lizard
{
void *_vt;
char* name;
} Lizard;
Lizard Lizard_init()
{
Lizard l;
l._vt = &_Lizard_traits;
l.name = "Lizard";
return l;
}

int main()
{
printf("\n");
int i;
for (i = 0; i < 5; i++)
{
printf("hello, world! ");
printf("%d", i + 1);
int x = i + 1;
if (x < 4) {
printf(" is less than 4");
} else {
printf(" is 4 or more");
}
printf("\n");
}
printf("\n");
int y = 0;
while (y < 5) {
printf("hi ");
y = y + 1;
}
printf("\n\n");
Dog dog = Dog_init();
printf("%s", dog.name);
printf(": ");
printf("%s", Dog_speak(&dog));
printf("\n\n");
Dog _x1 = Dog_init();
Cat _x2 = Cat_init();
Lizard _x3 = Lizard_init();
void *animals[3] = {&_x1, &_x2, &_x3};
for (int i = 0; i < 3; i++)
{
void **a = *(animals + i);
printf("%s", ((char *(*)(void *)) * _get_trait_func(a, 0, 0))(a));
printf("\n");
}
}
