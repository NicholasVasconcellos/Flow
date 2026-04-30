# React: shorthand vs. longhand style props

**Symptom:** `Warning: Updating a style property during rerender (borderColor) when a conflicting property is set (borderLeftColor) ...`

**Root cause:** DAG node style mixed `borderColor` (shorthand, sets all four sides) with `borderLeftColor` (longhand override). React can't reliably reconcile shorthand and longhand on the same element across renders — when one of them disappears, the other may not be reset cleanly.

**Fix:** if any longhand side-color is set, set the others as longhand too. For the DAG node we replaced `borderColor` with `borderTopColor` / `borderRightColor` / `borderBottomColor` and kept `borderLeftColor` as-is.

**Takeaway:** pick one form per CSS family per element. Same rule applies to `border` vs `borderLeft`, `margin` vs `marginTop`, `background` vs `backgroundColor`, etc.
