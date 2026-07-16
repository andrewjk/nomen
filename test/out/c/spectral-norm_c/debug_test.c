#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Buffer_float {
    void *_vt;
    unsigned long long data;
    long cap;
} Buffer_float;

int main() {
    Buffer_float b;
    b.data = 0;
    b.cap = 0;
    // alloc_float
    b.cap = 5;
    b.data = (unsigned long long)(double*)calloc(5, sizeof(double));
    
    // store_float
    ((double*)(unsigned long long)b.data)[0] = 1.0f;
    ((double*)(unsigned long long)b.data)[1] = 2.5f;
    ((double*)(unsigned long long)b.data)[2] = 3.14f;
    
    // load_float
    printf("load_float(0) = %f\n", ((double*)(unsigned long long)b.data)[0]);
    printf("load_float(1) = %f\n", ((double*)(unsigned long long)b.data)[1]);
    printf("load_float(2) = %f\n", ((double*)(unsigned long long)b.data)[2]);
    
    // Now test via pointer (as functions do)
    Buffer_float *self = &b;
    ((double*)(unsigned long long)self->data)[3] = 42.0f;
    printf("via ptr load(3) = %f\n", ((double*)(unsigned long long)self->data)[3]);
    return 0;
}
