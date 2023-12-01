
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

// Dog ===

void *_Dog_Animal_funcs[1] = {
  [0] = Dog_speak
};
void *_Dog_traits[1] = {
  [0] = _Dog_Animal_funcs
};

typedef struct Dog {
  void *_vt;
  char* name;
} Dog;
Dog Dog_init() {
  Dog d;
  d._vt = &_Dog_traits;
  d.name = "Dog";
  return d;
}
char* Dog_speak(struct Dog this) {
  return "woof";
}

// Cat ===

void *_Cat_Animal_funcs[1] = {
  [0] = Cat_speak
};
void *_Cat_traits[1] = {
  [0] = _Cat_Animal_funcs
};

typedef struct Cat {
  void *_vt;
  char* name;
} Cat;
Cat Cat_init() {
  Cat c;
  c._vt = &_Cat_traits;
  c.name = "Cat";
  return c;
}
char* Cat_speak(struct Cat this) {
  return "meow";
}

// Lizard ===

void *_Lizard_Animal_funcs[1] = {
  [0] = Lizard_speak
};
void *_Lizard_traits[1] = {
  [0] = _Lizard_Animal_funcs
};

typedef struct Lizard {
  void *_vt;
  char* name;
} Lizard;
Lizard Lizard_init() {
  Lizard l;
  l._vt = &_Lizard_traits;
  l.name = "Lizard";
  return l;
}
char* Lizard_speak(struct Lizard this) {
  return "hiss";
}

int main() {
  int i; for (i = 0; i < 5; i++) {
printf("hello, world! ");
printf("%d", i + 1);
printf("\n");
  }
printf("\n");
  Dog dog = Dog_init();
printf("%s", dog.name);
printf(": ");
printf("%s", Dog_speak(dog));
printf("\n");
}
