---
nomen-lang: minor
---

GUI framework absorbs the gallery's frame: registered pane roots (Container.set_pane + Window.relayout pane pass), a divider-holding SplitView delegate, Menu/Toolbar on_item_select handlers (take_item_select drains + selected_item payload getters), and synthesized composite tick forwards (the desugar appends the per-frame owner forward to the app's dispatch pump)
