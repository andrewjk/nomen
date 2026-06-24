#import <Foundation/Foundation.h>
#include <objc/runtime.h>
#include <objc/message.h>
#import <Cocoa/Cocoa.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <regex.h>

typedef struct Console
{
void *_vt;
} Console;
typedef struct Regex
{
void *_vt;
} Regex;

// Regex_test
unsigned char Regex_test(char* pattern, char* input) __asm__("Regex_test");
unsigned char Regex_test(char* pattern, char* input)
{
regex_t re;
if (regcomp(&re, pattern, REG_EXTENDED) != 0) return 0;
int rc = regexec(&re, input, 0, 0, 0);
regfree(&re);
return rc == 0 ? 1 : 0;

}

// Regex_match
char* Regex_match(char* pattern, char* input) __asm__("Regex_match");
char* Regex_match(char* pattern, char* input)
{
regex_t re;
if (regcomp(&re, pattern, REG_EXTENDED) != 0) return strdup("");
regmatch_t m[1];
int rc = regexec(&re, input, 1, m, 0);
regfree(&re);
if (rc != 0) return strdup("");
long len = m[0].rm_eo - m[0].rm_so;
char* out = (char*)malloc(len + 1);
memcpy(out, input + m[0].rm_so, len);
out[len] = 0;
return out;

}

// Regex_count
long Regex_count(char* pattern, char* input) __asm__("Regex_count");
long Regex_count(char* pattern, char* input)
{
regex_t re;
if (regcomp(&re, pattern, REG_EXTENDED) != 0) return 0;
int count = 0;
const char *p = input;
regmatch_t m[1];
while (regexec(&re, p, 1, m, 0) == 0) {
count++;
p += m[0].rm_eo;
if (m[0].rm_so == m[0].rm_eo) p++;
}
regfree(&re);
return count;

}

// Regex_replace_all
char* Regex_replace_all(char* pattern, char* input, char* replacement) __asm__("Regex_replace_all");
char* Regex_replace_all(char* pattern, char* input, char* replacement)
{
regex_t re;
if (regcomp(&re, pattern, REG_EXTENDED) != 0) return strdup(input);
long input_len = strlen(input);
long rep_len = strlen(replacement);
long result_cap = input_len + 1;
char *result = (char*)malloc(result_cap);
result[0] = 0;
long rpos = 0;
const char *p = input;
regmatch_t m[1];
while (regexec(&re, p, 1, m, 0) == 0) {
long match_start = m[0].rm_so;
long match_len = m[0].rm_eo - m[0].rm_so;
long prefix_len = match_start;
long new_len = rpos + prefix_len + rep_len;
if (new_len + 1 > result_cap) {
result_cap = new_len * 2 + 1;
result = (char*)realloc(result, result_cap);
}
memcpy(result + rpos, p, prefix_len);
rpos += prefix_len;
memcpy(result + rpos, replacement, rep_len);
rpos += rep_len;
p += match_start + match_len;
if (match_len == 0) { p++; }
}
long tail_len = input + input_len - p;
long new_len = rpos + tail_len;
if (new_len + 1 > result_cap) {
result = (char*)realloc(result, new_len + 1);
}
memcpy(result + rpos, p, tail_len);
rpos += tail_len;
result[rpos] = 0;
regfree(&re);
return result;

}

