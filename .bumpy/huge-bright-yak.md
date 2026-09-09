---
nomen-lang: patch
---

Close the plain string assignment residuals: borrow-initialized assignees now take an ownership restart (borrow receptions strdup'd on both backends, sound under untaken restart branches), explicit s = mov t actually transfers (was a C double free), and the C move gate accepts bare-variable-initializer sources
