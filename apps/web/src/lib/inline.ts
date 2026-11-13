/** Whether `node` opens its parent's text: nothing but collapsible white space comes before it. */
export function opensItsBlock(node: Node): boolean {
  let prev = node.previousSibling;
  while (prev?.nodeType === Node.TEXT_NODE && !/[^ \t\n\r\f]/.test(prev.textContent ?? "")) prev = prev.previousSibling;
  return !prev;
}
