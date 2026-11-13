/**
 * The box, in the window, of the text selected in a text area (a text area has no ranges to measure): a hidden copy
 * of it with the same type, padding and width holds the same words, the selected ones in a span, and the span's lines
 * are read. Cut to what the text area shows, so a selection scrolled out of it is its nearest edge. Without layout
 * (the tests' DOM) it is the text area's own box.
 */
export function selectionRect(el: HTMLTextAreaElement, start: number, end: number) {
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const copy = document.createElement("div");
  const picked = document.createElement("span");
  picked.textContent = el.value.slice(start, end);
  // The words after the selection too: a word cut by its end wraps as the whole word does.
  copy.append(el.value.slice(0, start), picked, el.value.slice(end));
  Object.assign(copy.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    left: `${box.left + el.clientLeft}px`,
    top: `${box.top + el.clientTop - el.scrollTop}px`,
    width: `${el.clientWidth}px`,
    padding: cs.padding,
    font: cs.font,
    letterSpacing: cs.letterSpacing,
    tabSize: cs.tabSize,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  document.body.append(copy);
  const lines = Array.from(picked.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  copy.remove();
  if (lines.length === 0) return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  const left = Math.min(...lines.map((r) => r.left));
  const right = Math.max(...lines.map((r) => r.right));
  const top = Math.min(...lines.map((r) => r.top));
  const bottom = Math.max(...lines.map((r) => r.bottom));
  return {
    left: Math.max(box.left, Math.min(left, box.right)),
    right: Math.max(box.left, Math.min(right, box.right)),
    top: Math.max(box.top, Math.min(top, box.bottom)),
    bottom: Math.max(box.top, Math.min(bottom, box.bottom)),
  };
}
