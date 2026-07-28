#import <Foundation/Foundation.h>
#include <objc/runtime.h>
#include <objc/message.h>
#import <Cocoa/Cocoa.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <regex.h>

typedef enum { LayoutLength_auto, LayoutLength_fixed, LayoutLength_percent, LayoutLength_fill } nm_LayoutLength_tag;
struct LayoutLength;
typedef struct LayoutLength
{
nm_LayoutLength_tag tag;
union {
struct {  } _auto;
struct { long pixels; } _fixed;
struct { long numerator; } _percent;
struct {  } _fill;
} _data;
} nm_LayoutLength;
typedef enum { Alignment_start, Alignment_center, Alignment_end, Alignment_stretch } nm_Alignment;

typedef struct Console
{
void *_vt;
} nm_Console;
typedef struct Button
{
void *_vt;
unsigned long long handle;
} nm_Button;
typedef struct CheckBox
{
void *_vt;
unsigned long long handle;
} nm_CheckBox;
typedef struct Window
{
void *_vt;
unsigned long long handle;
} nm_Window;
typedef struct Buffer_int
{
void *_vt;
unsigned long long data;
long cap;
} nm_Buffer_int;
typedef struct Container
{
void *_vt;
nm_Buffer_int kinds;
nm_Buffer_int ws;
nm_Buffer_int hs;
nm_Buffer_int gaps;
nm_Buffer_int pars;
nm_Buffer_int spans;
nm_Buffer_int cols;
nm_Buffer_int handles;
nm_Buffer_int grows;
nm_Buffer_int aligns;
nm_Buffer_int rx;
nm_Buffer_int ry;
nm_Buffer_int rw;
nm_Buffer_int rh;
long root;
long count;
long padding;
} nm_Container;
typedef struct Size
{
void *_vt;
long width;
long height;
} nm_Size;
typedef struct Frame
{
void *_vt;
long x;
long y;
long width;
long height;
} nm_Frame;
typedef struct Insets
{
void *_vt;
long top;
long right;
long bottom;
long left;
} nm_Insets;
typedef struct BoxConstraints
{
void *_vt;
long min_width;
long min_height;
long max_width;
long max_height;
} nm_BoxConstraints;
typedef struct LayoutParams
{
void *_vt;
nm_LayoutLength width;
nm_LayoutLength height;
long grow;
long shrink;
nm_Alignment align_self;
} nm_LayoutParams;
typedef struct Layout
{
void *_vt;
nm_Buffer_int kinds;
nm_Buffer_int ws;
nm_Buffer_int hs;
nm_Buffer_int gaps;
nm_Buffer_int par;
nm_Buffer_int rx;
nm_Buffer_int ry;
nm_Buffer_int rw;
nm_Buffer_int rh;
} nm_Layout;
typedef struct Text
{
void *_vt;
unsigned long long handle;
} nm_Text;
typedef struct TextBox
{
void *_vt;
unsigned long long handle;
} nm_TextBox;

// Button_init
void Button_init(nm_Button *self, nm_Window *window, char* title) __asm__("Button_init");
void Button_init(nm_Button *self, nm_Window *window, char* title)
{
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
self->handle = (uint64_t)btn;

}

// Button_set_frame
void Button_set_frame(nm_Button *self, long x, long y, long width, long height) __asm__("Button_set_frame");
void Button_set_frame(nm_Button *self, long x, long y, long width, long height)
{
nm_Button _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// Button_set_title
void Button_set_title(nm_Button *self, char* title) __asm__("Button_set_title");
void Button_set_title(nm_Button *self, char* title)
{
nm_Button _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setTitle:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), title));

}

// Button_destroy
void Button_destroy(nm_Button *self) __asm__("Button_destroy");
void Button_destroy(nm_Button *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// CheckBox_init
void CheckBox_init(nm_CheckBox *self, nm_Window *window) __asm__("CheckBox_init");
void CheckBox_init(nm_CheckBox *self, nm_Window *window)
{
id cb = ((id(*)(id, SEL, CGRect))objc_msgSend)(
((id(*)(id, SEL))objc_msgSend)((id)objc_getClass("NSButton"), sel_registerName("alloc")),
sel_registerName("initWithFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)(0, 0, 200, 24));
((void(*)(id, SEL, unsigned long))objc_msgSend)(
cb, sel_registerName("setButtonType:"), 3); // NSSwitchButton = 3
((void(*)(id, SEL, long))objc_msgSend)(
cb, sel_registerName("setState:"), 0);       // NSControlStateValueOff = 0
id contentView = ((id(*)(id, SEL))objc_msgSend)(
(id)window->handle, sel_registerName("contentView"));
((void(*)(id, SEL, id))objc_msgSend)(
contentView, sel_registerName("addSubview:"), cb);
self->handle = (uint64_t)cb;

}

// CheckBox_set_frame
void CheckBox_set_frame(nm_CheckBox *self, long x, long y, long width, long height) __asm__("CheckBox_set_frame");
void CheckBox_set_frame(nm_CheckBox *self, long x, long y, long width, long height)
{
nm_CheckBox _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// CheckBox_set_title
void CheckBox_set_title(nm_CheckBox *self, char* title) __asm__("CheckBox_set_title");
void CheckBox_set_title(nm_CheckBox *self, char* title)
{
nm_CheckBox _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setTitle:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), title));

}

// CheckBox_set_checked
void CheckBox_set_checked(nm_CheckBox *self, unsigned char checked) __asm__("CheckBox_set_checked");
void CheckBox_set_checked(nm_CheckBox *self, unsigned char checked)
{
nm_CheckBox _self = *self;
((void(*)(id, SEL, long))objc_msgSend)(
(id)self->handle, sel_registerName("setState:"),
checked ? 1 : 0); // NSControlStateValueOn = 1, Off = 0

}

// CheckBox_is_checked
unsigned char CheckBox_is_checked(nm_CheckBox *self) __asm__("CheckBox_is_checked");
unsigned char CheckBox_is_checked(nm_CheckBox *self)
{
nm_CheckBox _self = *self;
long state = ((long(*)(id, SEL))objc_msgSend)(
(id)self->handle, sel_registerName("state"));
return state == 1; // NSControlStateValueOn = 1

}

// CheckBox_set_hidden
void CheckBox_set_hidden(nm_CheckBox *self, unsigned char hidden) __asm__("CheckBox_set_hidden");
void CheckBox_set_hidden(nm_CheckBox *self, unsigned char hidden)
{
nm_CheckBox _self = *self;
((void(*)(id, SEL, BOOL))objc_msgSend)(
(id)self->handle, sel_registerName("setHidden:"), hidden ? 1 : 0);

}

// CheckBox_destroy
void CheckBox_destroy(nm_CheckBox *self) __asm__("CheckBox_destroy");
void CheckBox_destroy(nm_CheckBox *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// Window_init
void Window_init(nm_Window *self, char* title, long width, long height) __asm__("Window_init");
void Window_init(nm_Window *self, char* title, long width, long height)
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
self->handle = (uint64_t)win;

}

// Window_show
void Window_show(nm_Window *self) __asm__("Window_show");
void Window_show(nm_Window *self)
{
nm_Window _self = *self;
((void(*)(id, SEL, id))objc_msgSend)((id)self->handle, sel_registerName("makeKeyAndOrderFront:"), 0);

}

// Window_set_title
void Window_set_title(nm_Window *self, char* title) __asm__("Window_set_title");
void Window_set_title(nm_Window *self, char* title)
{
nm_Window _self = *self;
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
// Process run loop sources (Apple Events, timers) so that dock Quit
// and other system interactions work without NSApplication.run().
CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, 1);
return had_click;

}

// Window_is_visible
unsigned char Window_is_visible(nm_Window *self) __asm__("Window_is_visible");
unsigned char Window_is_visible(nm_Window *self)
{
nm_Window _self = *self;
BOOL vis = ((BOOL(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("isVisible"));
return vis;

}

// Window_click_x
long Window_click_x(nm_Window *self) __asm__("Window_click_x");
long Window_click_x(nm_Window *self)
{
nm_Window _self = *self;
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
long Window_click_y(nm_Window *self) __asm__("Window_click_y");
long Window_click_y(nm_Window *self)
{
nm_Window _self = *self;
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

// Window_content_width
long Window_content_width(nm_Window *self) __asm__("Window_content_width");
long Window_content_width(nm_Window *self)
{
nm_Window _self = *self;
id cv = ((id(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("contentView"));
CGRect frame = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
return (int)frame.size.width;

}

// Window_content_height
long Window_content_height(nm_Window *self) __asm__("Window_content_height");
long Window_content_height(nm_Window *self)
{
nm_Window _self = *self;
id cv = ((id(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("contentView"));
CGRect frame = ((CGRect(*)(id, SEL))objc_msgSend)(cv, sel_registerName("frame"));
return (int)frame.size.height;

}

// Window_destroy
void Window_destroy(nm_Window *self) __asm__("Window_destroy");
void Window_destroy(nm_Window *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// Text_init
void Text_init(nm_Text *self, nm_Window *window) __asm__("Text_init");
void Text_init(nm_Text *self, nm_Window *window)
{
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
self->handle = (uint64_t)label;

}

// Text_set_text
void Text_set_text(nm_Text *self, char* text) __asm__("Text_set_text");
void Text_set_text(nm_Text *self, char* text)
{
nm_Text _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setStringValue:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), text));

}

// Text_set_frame
void Text_set_frame(nm_Text *self, long x, long y, long width, long height) __asm__("Text_set_frame");
void Text_set_frame(nm_Text *self, long x, long y, long width, long height)
{
nm_Text _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// Text_destroy
void Text_destroy(nm_Text *self) __asm__("Text_destroy");
void Text_destroy(nm_Text *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// TextBox_init
void TextBox_init(nm_TextBox *self, nm_Window *window) __asm__("TextBox_init");
void TextBox_init(nm_TextBox *self, nm_Window *window)
{
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
self->handle = (uint64_t)field;

}

// TextBox_set_frame
void TextBox_set_frame(nm_TextBox *self, long x, long y, long width, long height) __asm__("TextBox_set_frame");
void TextBox_set_frame(nm_TextBox *self, long x, long y, long width, long height)
{
nm_TextBox _self = *self;
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)self->handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)((double)x, (double)y, (double)width, (double)height));

}

// TextBox_set_text
void TextBox_set_text(nm_TextBox *self, char* text) __asm__("TextBox_set_text");
void TextBox_set_text(nm_TextBox *self, char* text)
{
nm_TextBox _self = *self;
((void(*)(id, SEL, id))objc_msgSend)(
(id)self->handle, sel_registerName("setStringValue:"),
((id(*)(id, SEL, const char*))objc_msgSend)(
(id)objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), text));

}

// TextBox_get_text
char* TextBox_get_text(nm_TextBox *self) __asm__("TextBox_get_text");
char* TextBox_get_text(nm_TextBox *self)
{
nm_TextBox _self = *self;
id str = ((id(*)(id, SEL))objc_msgSend)(
(id)self->handle, sel_registerName("stringValue"));
const char *cstr = ((const char*(*)(id, SEL))objc_msgSend)(
str, sel_registerName("UTF8String"));
return strdup(cstr);

}

// TextBox_destroy
void TextBox_destroy(nm_TextBox *self) __asm__("TextBox_destroy");
void TextBox_destroy(nm_TextBox *self)
{
if (self->handle) {
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("removeFromSuperview"));
((void(*)(id, SEL))objc_msgSend)((id)self->handle, sel_registerName("release"));
self->handle = 0;
}

}

// is_visible
unsigned char is_visible(unsigned long long handle) __asm__("is_visible");
unsigned char is_visible(unsigned long long handle)
{
BOOL hidden = ((BOOL(*)(id, SEL))objc_msgSend)((id)handle, sel_registerName("isHidden"));
return !hidden;

}

// apply_frame
void apply_frame(unsigned long long handle, long x, long y, long w, long h, long content_h) __asm__("apply_frame");
void apply_frame(unsigned long long handle, long x, long y, long w, long h, long content_h)
{
((void(*)(id, SEL, CGRect))objc_msgSend)(
(id)handle, sel_registerName("setFrame:"),
((CGRect(*)(double, double, double, double))CGRectMake)(
(double)x, (double)(content_h - y - h), (double)w, (double)h));

}

