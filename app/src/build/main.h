#import <Foundation/Foundation.h>
#include <objc/runtime.h>
#include <objc/message.h>
#import <Cocoa/Cocoa.h>
#include <stdint.h>
struct Disposable;
struct Stringable;
struct Viewable;
struct Control;
struct Console;
struct Button;
struct CheckBox;
struct LayoutParams;
struct Size;
struct Frame;
struct Insets;
struct BoxConstraints;
struct Window;
struct Container;
struct Layout;
struct Text;
struct TextBox;
struct _Tuple_int_int;
struct Buffer_int;
// Trait Disposable
struct Disposable;
void Disposable_dispose(struct Disposable *self);

// Trait Stringable
struct Stringable;
char* Stringable_to_string(struct Stringable *self);

// Trait Viewable
struct Viewable;

// Trait Control
struct Control;

// Enum LayoutLength
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
nm_LayoutLength LayoutLength_auto_init();
nm_LayoutLength LayoutLength_fixed_init(long pixels);
nm_LayoutLength LayoutLength_percent_init(long numerator);
nm_LayoutLength LayoutLength_fill_init();

// Enum Alignment
typedef enum { Alignment_start, Alignment_center, Alignment_end, Alignment_stretch } nm_Alignment;

char* int_to_string(long self);
long int_parse(char* s);
char* uint_to_string(unsigned long self);
char* int8_to_string(char self);
char* uint8_to_string(unsigned char self);
char* float_to_string(double self);
char* char_to_string(char self);
char* string_to_string(char* self);
char string_at(char* self, long index);
nomen_view string_slice(char* self, long start, long end);
void string_set(char* *self, long index, char value);
char* string_add(char* self, char* other);
char* string_mul(char* self, long count);
// Struct Console
struct Console;
struct Console Console_init();
void Console_write(char* line);
void Console_write_line(char* line);
char* Console_read_line();
char Console_read_char();
char* Console_platform();

char* bool_to_string(unsigned char self);
// Struct Button
struct Button;
struct Button* Button_init(struct Window *window, char* title);
void Button_set_frame(struct Button *self, long x, long y, long width, long height);
void Button_set_title(struct Button *self, char* title);
void Button_destroy(struct Button *self);

// Struct CheckBox
struct CheckBox;
struct CheckBox* CheckBox_init(struct Window *window);
void CheckBox_set_frame(struct CheckBox *self, long x, long y, long width, long height);
void CheckBox_set_title(struct CheckBox *self, char* title);
void CheckBox_set_checked(struct CheckBox *self, unsigned char checked);
unsigned char CheckBox_is_checked(struct CheckBox *self);
void CheckBox_set_hidden(struct CheckBox *self, unsigned char hidden);
void CheckBox_destroy(struct CheckBox *self);

// Struct LayoutParams
struct LayoutParams;
struct LayoutParams LayoutParams_init();

// Struct Size
struct Size;
struct Size Size_init();

// Struct Frame
struct Frame;
struct Frame Frame_init();

// Struct Insets
struct Insets;
struct Insets Insets_init();

// Struct BoxConstraints
struct BoxConstraints;
struct BoxConstraints BoxConstraints_init();
struct BoxConstraints;
struct BoxConstraints BoxConstraints_tighten_width(struct BoxConstraints *self, long min, long max);
struct BoxConstraints;
struct BoxConstraints BoxConstraints_tighten_height(struct BoxConstraints *self, long min, long max);
long BoxConstraints_clamp_width(struct BoxConstraints *self, long value);
long BoxConstraints_clamp_height(struct BoxConstraints *self, long value);
unsigned char BoxConstraints_is_width_bounded(struct BoxConstraints *self);
unsigned char BoxConstraints_is_height_bounded(struct BoxConstraints *self);

// Struct Window
void Window_destroy(struct Window *);
struct Window;
struct Window* Window_init(char* title, long width, long height);
void Window_show(struct Window *self);
void Window_set_title(struct Window *self, char* title);
void Window_run();
long Window_process_events();
unsigned char Window_is_visible(struct Window *self);
long Window_click_x(struct Window *self);
long Window_click_y(struct Window *self);
long Window_content_width(struct Window *self);
long Window_content_height(struct Window *self);
struct Size;
struct BoxConstraints;
struct Size Window_measure(struct Window *self, struct BoxConstraints *constraints);
struct Size;
struct Size Window_intrinsic_size(struct Window *self);
void Window_set_frame(struct Window *self, long x, long y, long width, long height);
void Window_destroy(struct Window *self);

// Struct Container
struct Container;
struct Container Container_init();
void Container_init_buffers(struct Container *self, long cap);
void Container_make_root(struct Container *self, long kind, long gap, long col_count);
long Container_first_child(struct Container *self, long parent);
long Container_next_sibling(struct Container *self, long after, long parent);
long Container_append_node(struct Container *self, long parent, long kind, long handle, long gap, long cols, long span, long grow, long shrink, long align);
long Container_root_index(struct Container *self);
void Container_add(struct Container *self, unsigned long long handle, long w, long h, long span, long grow, long align, long shrink);
void Container_add_to(struct Container *self, long parent, unsigned long long handle, long w, long h, long span, long grow, long align, long shrink);
void Container_add_kind(struct Container *self, unsigned long long handle, long w_kind, long w_val, long h_kind, long h_val, long span, long grow, long align, long shrink);
void Container_add_to_kind(struct Container *self, long parent, unsigned long long handle, long w_kind, long w_val, long h_kind, long h_val, long span, long grow, long align, long shrink);
void Container_add_len(struct Container *self, unsigned long long handle, nm_LayoutLength w, nm_LayoutLength h, long span, long grow, long align, long shrink);
void Container_add_to_len(struct Container *self, long parent, unsigned long long handle, nm_LayoutLength w, nm_LayoutLength h, long span, long grow, long align, long shrink);
void Container_add_intrinsic(struct Container *self, unsigned long long handle, long span, long grow, long align, long shrink);
void Container_add_to_intrinsic(struct Container *self, long parent, unsigned long long handle, long span, long grow, long align, long shrink);
void Container_set_leaf_size(struct Container *self, long idx, long w, long h);
void Container_set_leaf_kind(struct Container *self, long idx, long w_kind, long w_val, long h_kind, long h_val);
long Container_add_vstack(struct Container *self, long parent, long spacing, long span, long grow, long align, long shrink);
long Container_add_hstack(struct Container *self, long parent, long spacing, long span, long grow, long align, long shrink);
void Container_add_spacer(struct Container *self, long span, long grow, long shrink, long align);
void Container_add_spacer_to(struct Container *self, long parent, long span, long grow, long shrink, long align);
long Container_add_grid(struct Container *self, long parent, long cols, long spacing, long span, long grow, long align, long shrink);
long Container_add_zstack(struct Container *self, long parent, long span, long grow, long align, long shrink);
long Container_add_block(struct Container *self, long padding, long span, long grow, long align, long shrink);
long Container_add_block_to(struct Container *self, long parent, long padding, long span, long grow, long align, long shrink);
long Container_measure(struct Container *self, long idx, long min_w, long max_w, long min_h, long max_h);
void Container_arrange(struct Container *self, long idx, long x, long y, long w, long h);
void Container_collect_dirty(struct Container *self);
long Container_dirty_count(struct Container *self);
char* Container_dirty_rect(struct Container *self, long i);
void Container_mark_dirty(struct Container *self, long idx);
long Container_measure_count(struct Container *self, long i);
void Container_apply(struct Container *self, long content_w, long content_h);
void Container_compute(struct Container *self, long avail_w, long avail_h);
struct Window;
void Container_layout(struct Container *self, struct Window *win);
struct Window;
void Container_set_resize_callback(struct Container *self, struct Window *win);
struct Container;
struct Window;
// nomen_layout_thunk is a free function (defined in Nomen below) that
// forwards to Container.layout — exported for C linkage on both
// backends, unlike the layout method itself.
extern void nomen_layout_thunk(struct Container*, struct Window*);
static void *g_resize_grid = 0;
static void *g_resize_win = 0;
void nomen_set_resize_target(void *grid, void *win) {
g_resize_grid = grid;
g_resize_win = win;
}
void nomen_window_did_resize(id self, SEL cmd, id notification) {
(void)self; (void)cmd; (void)notification;
if (g_resize_grid && g_resize_win) {
nomen_layout_thunk((struct Container*)g_resize_grid, (struct Window*)g_resize_win);
}
}
unsigned char Container_contains(struct Container *self, unsigned long long handle, long cx, long cy);
unsigned long long Container_hit_test(struct Container *self, long cx, long cy);
long Container_hit_test_index(struct Container *self, long cx, long cy);
long Container_hit_test_node(struct Container *self, long idx, long cx, long cy);
char* Container_fmt_frame(struct Container *self, long i);

// Struct Layout
struct Layout;
struct Layout Layout_init();

// Struct Text
void Text_destroy(struct Text *);
struct Text;
struct Text* Text_init(struct Window *window);
void Text_set_text(struct Text *self, char* text);
struct Size;
struct BoxConstraints;
struct Size Text_measure(struct Text *self, struct BoxConstraints *constraints);
struct Size;
struct Size Text_intrinsic_size(struct Text *self);
void Text_set_frame(struct Text *self, long x, long y, long width, long height);
void Text_destroy(struct Text *self);

// Struct TextBox
struct TextBox;
struct TextBox* TextBox_init(struct Window *window);
void TextBox_set_frame(struct TextBox *self, long x, long y, long width, long height);
void TextBox_set_text(struct TextBox *self, char* text);
char* TextBox_get_text(struct TextBox *self);
void TextBox_destroy(struct TextBox *self);

// Struct _Tuple_int_int
struct _Tuple_int_int;
struct _Tuple_int_int _Tuple_int_int_init(long _0, long _1);

// Struct Buffer_int
struct Buffer_int;
struct Buffer_int Buffer_int_init();
long Buffer_int_alloc(struct Buffer_int *self, long size);
long Buffer_int_grow(struct Buffer_int *self, long needed);
void Buffer_int_zero(struct Buffer_int *self, long len);
unsigned int Buffer_int_load(struct Buffer_int *self, long i);
void Buffer_int_store(struct Buffer_int *self, long i, unsigned int val);
void Buffer_int_store_or(struct Buffer_int *self, long i, unsigned int val);
long Buffer_int_alloc_int(struct Buffer_int *self, long size);
long Buffer_int_grow_int(struct Buffer_int *self, long needed);
long Buffer_int_load_int(struct Buffer_int *self, long i);
void Buffer_int_store_int(struct Buffer_int *self, long i, long val);
long Buffer_int_move_int(struct Buffer_int *self, long i);
void Buffer_int_replace_int(struct Buffer_int *self, long i, long val);
void Buffer_int_zero_int(struct Buffer_int *self, long len);
long Buffer_int_alloc_T(struct Buffer_int *self, long size);
long Buffer_int_grow_T(struct Buffer_int *self, long needed);
long Buffer_int_load_T(struct Buffer_int *self, long i);
void Buffer_int_store_T(struct Buffer_int *self, long i, long val);
nomen_view Buffer_int_slice(struct Buffer_int *self, long start, long end);
void Buffer_int_zero_T(struct Buffer_int *self, long len);
void Buffer_int_store_or_int(struct Buffer_int *self, long i, long val);
long Buffer_int_alloc_float(struct Buffer_int *self, long size);
double Buffer_int_load_float(struct Buffer_int *self, long i);
void Buffer_int_store_float(struct Buffer_int *self, long i, double val);
void Buffer_int_destroy(struct Buffer_int *self);

extern long WIN_W;
extern long WIN_H;
extern long MAX_TODOS;
extern long MAX_DIM;
extern long KIND_LEAF;
extern long KIND_VSTACK;
extern long KIND_HSTACK;
extern long KIND_GRID;
extern long KIND_ZSTACK;
extern long KIND_BLOCK;
extern long ALIGN_START;
extern long ALIGN_CENTER;
extern long ALIGN_END;
extern long ALIGN_STRETCH;
extern long LEN_AUTO;
extern long LEN_FIXED;
extern long LEN_PERCENT;
extern long LEN_FILL;
extern long LEN_INTRINSIC;
extern long INF;
// Func main
int main();

// Func length_kind
long length_kind(nm_LayoutLength len);

// Func length_val
long length_val(nm_LayoutLength len);

// Func is_visible
unsigned char is_visible(unsigned long long handle);

// Func apply_frame
void apply_frame(unsigned long long handle, long x, long y, long w, long h, long content_w, long content_h);

// Func intrinsic_size
struct _Tuple_int_int intrinsic_size(unsigned long long handle);

// Func nomen_layout_thunk
void nomen_layout_thunk(struct Container *grid, struct Window *win);

// Func VStack
struct Container VStack(long spacing);

// Func HStack
struct Container HStack(long spacing);

// Func ZStack
struct Container ZStack();

// Func Grid
struct Container Grid(long cols, long spacing);

// Func init_layout
void init_layout(struct Layout *l, long cap);

// Func add_leaf
long add_leaf(struct Layout *l, long parent, long w, long h);

// Func add_vstack
long add_vstack(struct Layout *l, long parent, long spacing);

// Func add_hstack
long add_hstack(struct Layout *l, long parent, long spacing);

// Func first_child
long first_child(struct Layout *l, long count, long parent);

// Func next_sibling
long next_sibling(struct Layout *l, long count, long after, long parent);

// Func measure_w
long measure_w(struct Layout *l, long count, long idx, long min_w, long max_w, long min_h, long max_h);

// Func arrange
void arrange(struct Layout *l, long count, long idx, long x, long y, long w, long h);

// Func run_layout
void run_layout(struct Layout *l, long count, long root, long avail_w, long avail_h);

// Func fmt
char* fmt(struct Layout *l, long idx);

void **_get_trait_func(void **obj, int trait_index, int func_index);
void Disposable_destroy(void *obj);
void Stringable_destroy(void *obj);
void Viewable_destroy(void *obj);
void Control_destroy(void *obj);
