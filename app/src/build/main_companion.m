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
typedef struct Button
{
void *_vt;
unsigned long long handle;
} Button;
typedef struct CheckBox
{
void *_vt;
unsigned long long handle;
} CheckBox;
typedef struct Layout
{
void *_vt;
void * kinds;
void * ws;
void * hs;
void * gaps;
void * par;
void * rx;
void * ry;
void * rw;
void * rh;
} Layout;
typedef struct Text
{
void *_vt;
unsigned long long handle;
} Text;
typedef struct TextBox
{
void *_vt;
unsigned long long handle;
} TextBox;
typedef struct Window
{
void *_vt;
unsigned long long handle;
} Window;
typedef struct Buffer_int
{
void *_vt;
unsigned long long data;
long cap;
} Buffer_int;

// Button_create
struct Button Button_create_c(struct Window *window, char* title) __asm__("Button_create_c");
struct Button Button_create_c(struct Window *window, char* title)
{
struct Button result;
id btn = ((id(*)(id, SEL, CGRect))objc_msgSend)(
((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSButton"), sel_registerName("alloc")),
sel_registerName("initWithFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)(0, 0, 100, 32));
((void(*)(id, SEL, unsigned long))objc_msgSend)(
btn, sel_registerName("setButtonType:"), 1); // NSPushInButton = 1 (momentary push)
((void(*)(id, SEL, id))objc_msgSend)(
btn, sel_registerName("setTitle:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), title));
id contentView = ((id(*)(id, SEL))objc_msgSend)(
(id)window->handle, sel_registerName("contentView"));
((void(*)(id, SEL, id))objc_msgSend)(
contentView, sel_registerName("addSubview:"), btn);
result.handle = (uint64_t)btn;
return result;

}

// Button_set_frame
void Button_set_frame(struct Button *self, long x, long y, long width, long height) __asm__("Button_set_frame");
void Button_set_frame(struct Button *self, long x, long y, long width, long height)
{
struct Button _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// Button_set_title
void Button_set_title(struct Button *self, char* title) __asm__("Button_set_title");
void Button_set_title(struct Button *self, char* title)
{
struct Button _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setTitle:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), title));

}

// Button_destroy
void Button_destroy(struct Button *self) __asm__("Button_destroy");
void Button_destroy(struct Button *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// CheckBox_create
struct CheckBox CheckBox_create_c(struct Window *window) __asm__("CheckBox_create_c");
struct CheckBox CheckBox_create_c(struct Window *window)
{
struct CheckBox result;
id cb = ((id(*)(id, SEL, CGRect))objc_msgSend)(
((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSButton"), sel_registerName("alloc")),
sel_registerName("initWithFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)(0, 0, 200, 24));
((void(*)(id, SEL, unsigned long))objc_msgSend)(
cb, sel_registerName("setButtonType:"), 4); // NSSwitchButton = 4
((void(*)(id, SEL, long))objc_msgSend)(
cb, sel_registerName("setState:"), 0);       // NSControlStateValueOff = 0
id contentView = ((id(*)(id, SEL))objc_msgSend)(
(id)window->handle, sel_registerName("contentView"));
((void(*)(id, SEL, id))objc_msgSend)(
contentView, sel_registerName("addSubview:"), cb);
result.handle = (uint64_t)cb;
return result;

}

// CheckBox_set_frame
void CheckBox_set_frame(struct CheckBox *self, long x, long y, long width, long height) __asm__("CheckBox_set_frame");
void CheckBox_set_frame(struct CheckBox *self, long x, long y, long width, long height)
{
struct CheckBox _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// CheckBox_set_title
void CheckBox_set_title(struct CheckBox *self, char* title) __asm__("CheckBox_set_title");
void CheckBox_set_title(struct CheckBox *self, char* title)
{
struct CheckBox _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setTitle:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), title));

}

// CheckBox_set_checked
void CheckBox_set_checked(struct CheckBox *self, unsigned char checked) __asm__("CheckBox_set_checked");
void CheckBox_set_checked(struct CheckBox *self, unsigned char checked)
{
struct CheckBox _self = *self;
((void(*)(id, SEL, long))objc_msgSend)(
(id)self->handle, sel_registerName("setState:"),
checked ? 1 : 0); // NSControlStateValueOn = 1, Off = 0

}

// CheckBox_is_checked
unsigned char CheckBox_is_checked(struct CheckBox *self) __asm__("CheckBox_is_checked");
unsigned char CheckBox_is_checked(struct CheckBox *self)
{
struct CheckBox _self = *self;
long state = ((long(*)(id, SEL))objc_msgSend)(
(id)self->handle, sel_registerName("state"));
return state == 1; // NSControlStateValueOn = 1

}

// CheckBox_destroy
void CheckBox_destroy(struct CheckBox *self) __asm__("CheckBox_destroy");
void CheckBox_destroy(struct CheckBox *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// Text_create
struct Text Text_create_c(struct Window *window) __asm__("Text_create_c");
struct Text Text_create_c(struct Window *window)
{
struct Text result;
id label = ((id(*)(id, SEL, CGRect))objc_msgSend)(
((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSTextField"), sel_registerName("alloc")),
sel_registerName("initWithFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)(10, 10, 200, 30));
((void(*)(id, SEL, BOOL))objc_msgSend)(
label, sel_registerName("setEditable:"), 0);
((void(*)(id, SEL, BOOL))objc_msgSend)(
label, sel_registerName("setSelectable:"), 0);
((void(*)(id, SEL, BOOL))objc_msgSend)(
label, sel_registerName("setBordered:"), 0);
((void(*)(id, SEL, BOOL))objc_msgSend)(
label, sel_registerName("setDrawsBackground:"), 0);
id contentView = ((id(*)(id, SEL))objc_msgSend)(
(id)window->handle, sel_registerName("contentView"));
((void(*)(id, SEL, id))objc_msgSend)(
contentView, sel_registerName("addSubview:"), label);
result.handle = (uint64_t)label;
return result;

}

// Text_set_text
void Text_set_text(struct Text *self, char* text) __asm__("Text_set_text");
void Text_set_text(struct Text *self, char* text)
{
struct Text _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setStringValue:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), text));

}

// Text_set_frame
void Text_set_frame(struct Text *self, long x, long y, long width, long height) __asm__("Text_set_frame");
void Text_set_frame(struct Text *self, long x, long y, long width, long height)
{
struct Text _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// Text_destroy
void Text_destroy(struct Text *self) __asm__("Text_destroy");
void Text_destroy(struct Text *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// TextBox_create
struct TextBox TextBox_create_c(struct Window *window) __asm__("TextBox_create_c");
struct TextBox TextBox_create_c(struct Window *window)
{
struct TextBox result;
id field = ((id(*)(id, SEL, CGRect))objc_msgSend)(
((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSTextField"), sel_registerName("alloc")),
sel_registerName("initWithFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)(0, 0, 200, 24));
((void(*)(id, SEL, BOOL))objc_msgSend)(
field, sel_registerName("setEditable:"), 1);
((void(*)(id, SEL, BOOL))objc_msgSend)(
field, sel_registerName("setSelectable:"), 1);
((void(*)(id, SEL, BOOL))objc_msgSend)(
field, sel_registerName("setBordered:"), 1);
((void(*)(id, SEL, BOOL))objc_msgSend)(
field, sel_registerName("setBezeled:"), 1);
((void(*)(id, SEL, BOOL))objc_msgSend)(
field, sel_registerName("setDrawsBackground:"), 1);
((void(*)(id, SEL, id))objc_msgSend)(
field, sel_registerName("setStringValue:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), ""));
id contentView = ((id(*)(id, SEL))objc_msgSend)(
(id)window->handle, sel_registerName("contentView"));
((void(*)(id, SEL, id))objc_msgSend)(
contentView, sel_registerName("addSubview:"), field);
result.handle = (uint64_t)field;
return result;

}

// TextBox_set_frame
void TextBox_set_frame(struct TextBox *self, long x, long y, long width, long height) __asm__("TextBox_set_frame");
void TextBox_set_frame(struct TextBox *self, long x, long y, long width, long height)
{
struct TextBox _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// TextBox_set_text
void TextBox_set_text(struct TextBox *self, char* text) __asm__("TextBox_set_text");
void TextBox_set_text(struct TextBox *self, char* text)
{
struct TextBox _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setStringValue:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), text));

}

// TextBox_get_text
char* TextBox_get_text(struct TextBox *self) __asm__("TextBox_get_text");
char* TextBox_get_text(struct TextBox *self)
{
struct TextBox _self = *self;
id str = ((id(*)(id, SEL))objc_msgSend)(
(id)self->handle, sel_registerName("stringValue"));
const char *cstr = ((const char*(*)(id, SEL))objc_msgSend)(
str, sel_registerName("UTF8String"));
return strdup(cstr);

}

// TextBox_destroy
void TextBox_destroy(struct TextBox *self) __asm__("TextBox_destroy");
void TextBox_destroy(struct TextBox *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// Window_create
struct Window Window_create_c(char* title, long width, long height) __asm__("Window_create_c");
struct Window Window_create_c(char* title, long width, long height)
{
// Set up NSApplication first
id app = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
((void(*)(id, SEL, long))objc_msgSend)(app, sel_registerName("setActivationPolicy:"), 0);
((void(*)(id, SEL, BOOL))objc_msgSend)(app, sel_registerName("activateIgnoringOtherApps:"), 1);
// Create window
unsigned long style = 1 | 2 | 4 | 8;
id win = ((id(*)(id, SEL, double, double, double, double, unsigned long, unsigned long, BOOL))objc_msgSend)(
((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSWindow"), sel_registerName("alloc")),
sel_registerName("initWithContentRect:styleMask:backing:defer:"),
0.0, 0.0, (double)width, (double)height,
style, 2, 0);
((id(*)(id, SEL, id))objc_msgSend)(
win, sel_registerName("setTitle:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), title));
((void(*)(id, SEL, double, double))objc_msgSend)(
win, sel_registerName("setFrameTopLeftPoint:"), 100.0, 100.0);
((void(*)(id, SEL, id))objc_msgSend)(win, sel_registerName("makeKeyAndOrderFront:"), (id)0);
struct Window result;
result.handle = (uint64_t)win;
return result;

}

// Window_show
void Window_show(struct Window *self) __asm__("Window_show");
void Window_show(struct Window *self)
{
struct Window _self = *self;
((void(*)(id, SEL, id))objc_msgSend)((id)self->handle, sel_registerName("makeKeyAndOrderFront:"), 0);

}

// Window_set_title
void Window_set_title(struct Window *self, char* title) __asm__("Window_set_title");
void Window_set_title(struct Window *self, char* title)
{
struct Window _self = *self;
((id(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setTitle:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), title));

}

// Window_run
void Window_run(void) __asm__("Window_run");
void Window_run(void)
{
((void(*)(id, SEL))objc_msgSend)(
((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication")), sel_registerName("run"));

}

// Window_process_events
long Window_process_events(void) __asm__("Window_process_events");
long Window_process_events(void)
{
id app = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
id distant_past = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSDate"), sel_registerName("distantPast"));
id default_mode = ((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), "kCFRunLoopDefaultMode");
int had_click = 0;
while (1) {
id event = ((id(*)(id, SEL, unsigned long long, id, id, BOOL))objc_msgSend)(
app, sel_registerName("nextEventMatchingMask:untilDate:inMode:dequeue:"),
0xFFFFFFFFFFFFFFFFULL, // NSEventMaskAny
distant_past,          // untilDate — returns immediately if no events
default_mode,          // inMode
1);                    // dequeue
if (!event) break;
((void(*)(id, SEL, id))objc_msgSend)(app, sel_registerName("sendEvent:"), event);
long type = ((long(*)(id, SEL))objc_msgSend)(event, sel_registerName("type"));
if (type == 1) had_click = 1; // NSLeftMouseDown = 1
}
return had_click;

}

// Window_click_x
long Window_click_x(struct Window *self) __asm__("Window_click_x");
long Window_click_x(struct Window *self)
{
struct Window _self = *self;
id app = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
id event = ((id(*)(id, SEL))objc_msgSend)(app, sel_registerName("currentEvent"));
if (!event) return -1;
long type = ((long(*)(id, SEL))objc_msgSend)(event, sel_registerName("type"));
if (type != 1) return -1; // NSLeftMouseDown = 1
// locationInWindow is a CGPoint inside the event; read it via struct-return
CGPoint loc = ((CGPoint(*)(id, SEL))objc_msgSend)(event, sel_registerName("locationInWindow"));
return (int)loc.x;

}

// Window_click_y
long Window_click_y(struct Window *self) __asm__("Window_click_y");
long Window_click_y(struct Window *self)
{
struct Window _self = *self;
id app = ((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
id event = ((id(*)(id, SEL))objc_msgSend)(app, sel_registerName("currentEvent"));
if (!event) return -1;
long type = ((long(*)(id, SEL))objc_msgSend)(event, sel_registerName("type"));
if (type != 1) return -1; // NSLeftMouseDown = 1
CGPoint loc = ((CGPoint(*)(id, SEL))objc_msgSend)(event, sel_registerName("locationInWindow"));
id cv = ((id(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("contentView"));
CGRect frame = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
// NSWindow coords are bottom-left origin; flip to top-left for layout math
return (int)(frame.size.height - loc.y);

}

// Window_content_height
long Window_content_height(struct Window *self) __asm__("Window_content_height");
long Window_content_height(struct Window *self)
{
struct Window _self = *self;
id cv = ((id(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("contentView"));
CGRect frame = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
return (int)frame.size.height;

}

// Window_destroy
void Window_destroy(struct Window *self) __asm__("Window_destroy");
void Window_destroy(struct Window *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

