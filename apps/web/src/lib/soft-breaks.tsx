import { Fragment, type ReactNode } from "react";

/**
 * A path or a page's address that wraps after its separators, never inside a folder's or a page's name unless it must
 * (with `overflow-wrap: anywhere` on its box). After each separator but a leading one, so "/Users/" stays whole.
 */
export function softBreaks(text: string): ReactNode {
  const parts = text.split(/(?<=.[\\/])/);
  if (parts.length < 2) return text;
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one path, in order
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}
