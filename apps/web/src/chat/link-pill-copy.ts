/**
 * `text` with each pill's words, in order, replaced by its address. `skip`: how many times the same words are written
 * before it, which stay ("Documento: " before a pill that reads "Documento").
 */
export function withPillAddresses(
  text: string,
  pills: readonly { text: string; href: string; skip: number }[],
): string {
  let out = "";
  let at = 0;
  for (const pill of pills) {
    let found = text.indexOf(pill.text, at);
    for (let n = pill.skip; n > 0 && found >= 0; n--) found = text.indexOf(pill.text, found + pill.text.length);
    if (found < 0) continue;
    out += text.slice(at, found) + pill.href;
    at = found + pill.text.length;
  }
  return out + text.slice(at);
}

/** What of a pill's words `range` holds. */
function selectedWords(pill: Element, range: Range): string {
  const own = document.createRange();
  own.selectNodeContents(pill);
  if (own.compareBoundaryPoints(Range.START_TO_START, range) < 0) own.setStart(range.startContainer, range.startOffset);
  if (own.compareBoundaryPoints(Range.END_TO_END, range) > 0) own.setEnd(range.endContainer, range.endOffset);
  return own.toString();
}

/** Selected text copied with a link pill in it says the full address, as the message was written; one half selected stays as it reads. */
export function copyPillAddresses(e: ClipboardEvent) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !e.clipboardData) return;
  // Firefox keeps the page's selection while a field's text is what's being copied.
  if (e.target instanceof Element && e.target.closest("input, textarea")) return;
  const range = selection.getRangeAt(0);
  const gap = range.cloneRange();
  const pills = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.link-pill"))
    .filter((a) => selection.containsNode(a, true) && selectedWords(a, range) === a.textContent)
    .map((a) => {
      const text = a.textContent ?? "";
      gap.setEndBefore(a);
      const skip = gap.toString().split(text).length - 1;
      gap.setStartAfter(a);
      gap.setEnd(range.endContainer, range.endOffset);
      return { text, href: a.getAttribute("href") ?? "", skip };
    });
  if (pills.length === 0) return;
  e.clipboardData.setData("text/plain", withPillAddresses(selection.toString(), pills));
  e.preventDefault();
}
