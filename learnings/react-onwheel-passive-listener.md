# React: `onWheel` is a passive listener

**Symptom:** `Unable to preventDefault inside passive event listener invocation.` while pinch/Ctrl-scrolling the DAG to zoom; the page scrolls/zooms underneath instead of the DAG zooming.

**Root cause:** React attaches `onWheel` (and `onTouchStart`/`onTouchMove`) as **passive** listeners since React 17. Inside a passive listener, `e.preventDefault()` is a no-op and the browser warns. There is no React-level escape hatch.

**Fix pattern:** register the listener manually with `{ passive: false }` in a `useEffect`, and drop the JSX prop:

```jsx
React.useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;
  const handler = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    /* ... zoom logic ... */
  };
  el.addEventListener("wheel", handler, { passive: false });
  return () => el.removeEventListener("wheel", handler);
}, [/* deps the handler closes over */]);
```

**Takeaway:** any time you need `preventDefault()` on `wheel`, `touchstart`, or `touchmove`, you must bypass React's synthetic-event wiring. The same pattern applies to drag-to-pan logic that wants to suppress native scroll.
