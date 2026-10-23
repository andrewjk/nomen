import { describe, test } from "vite-plus/test";

import build_and_check_output from "../build_and_check_output";

// The button demo (demos/button): the smallest App — one centered button
// whose registered on_click handler retitles it. performClick: fires the
// armed target/action exactly as a real click would; get_title reads the
// result back.
describe("Button demo", () => {
	test("on_click retitles the button", { timeout: 300000 }, async () => {
		const input = `
import System
import System::Controls

const WIN_W = 320
const WIN_H = 200

mv struct ButtonApp : App {
	var Button click
	var Container grid
	var int frames = 0

	pub func #init = (self, Window window) {
		var Button click = Button(window, "Click me")
		var Container grid = VStack(0)
		grid.add_spacer_to(grid.root_index(), 1, 1)
		grid.add_to_kind(grid.root_index(), click.handle, LEN_INTRINSIC, 0, LEN_INTRINSIC, 0, 1, 0, ALIGN_CENTER, 0)
		grid.add_spacer_to(grid.root_index(), 1, 1)
		self.click = click
		self.grid = grid
	}

	pub func start = (ref self, ref Window win) {
		win.set_content(ref self.grid)
		self.click.on_click(func () {
			self.click.set_title("Thank you")
		})
	}

	pub func poke = (ref self) {
		\`\`\`
		#arch: c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)(
			(id)self->click.handle, sel_registerName("performClick:"), (id)0);
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: macos
		((void(*)(id, SEL, id))objc_msgSend)(
			(id)self->click.handle, sel_registerName("performClick:"), (id)0);
		\`\`\`
		\`\`\`
		#arch: c
		#platform: ios
		/* TODO: iOS */
		\`\`\`
		\`\`\`
		#arch: aarch64_use_c
		#platform: ios
		/* TODO: iOS */
		\`\`\`
	}

	pub func frame = (ref self, ref Window win, FrameEvents ev) {
		self.frames = self.frames + 1
		if self.frames == 2 {
			self.poke()
		}
		// The click drained at frame 3's handle_events; the handler has
		// retitled the button. The center probe asserts the layout: the
		// window's center point must land INSIDE the button's laid-out
		// frame (a left-hugging button misses it).
		if self.frames == 3 {
			var int cx = win.content_width() / 2
			var int cy = win.content_height() / 2
			var bool centered = self.grid.contains(self.click.handle, cx, cy)
			Console.write_line("centered=\\{centered} title=\\{self.click.get_title()}")
			win.close()
		}
	}
}

pub func main = (Init init) {
	var Window win = Window("Button", WIN_W, WIN_H)
	var ButtonApp app = ButtonApp(win)
	win.run(mv app)
}
`;
		await build_and_check_output(input, "gui_button_demo", "centered=true title=Thank you", true, {
			platform: "macos",
			audit: false,
		});
	});
});
