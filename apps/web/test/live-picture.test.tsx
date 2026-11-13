import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { BrowserFrame } from "@agenteschat/client";
import { act, cleanup, render } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { LivePicture } from "@/components/browser/LivePicture";

afterEach(cleanup);

const META = { deviceWidth: 1280, deviceHeight: 800 };
/** A frame as the frame socket brings it: the JPEG's bytes. */
const bytes = (seq: number): BrowserFrame => ({
  agentId: "a1",
  seq,
  jpeg: new Uint8Array([0xff, 0xd8, seq]),
  metadata: META,
});

/** `blob:` addresses as the browser hands them out, and those freed, until `restore`. */
function blobUrls() {
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const made: string[] = [];
  const freed: string[] = [];
  URL.createObjectURL = () => {
    const url = `blob:frame-${made.length + 1}`;
    made.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    freed.push(url);
  };
  return {
    made,
    freed,
    restore: () => {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    },
  };
}

test("a frame's bytes show as a blob: address; the one replaced is freed once the next has loaded, the rest when it goes", () => {
  const urls = blobUrls();
  try {
    const img = createRef<HTMLImageElement>();
    const first = bytes(1);
    const view = render(<LivePicture frame={first} alt="The page" imgRef={img} />);
    expect(img.current?.getAttribute("src")).toBe("blob:frame-1");
    expect(img.current?.getAttribute("alt")).toBe("The page");
    // The same frame again (the card rendered for something else): no new address.
    view.rerender(<LivePicture frame={first} alt="The page" imgRef={img} />);
    expect(urls.made).toEqual(["blob:frame-1"]);
    view.rerender(<LivePicture frame={bytes(2)} alt="The page" imgRef={img} />);
    expect(img.current?.getAttribute("src")).toBe("blob:frame-2");
    // The picture on screen stays until the next one is ready.
    expect(urls.freed).toEqual([]);
    act(() => void img.current?.dispatchEvent(new Event("load")));
    expect(urls.freed).toEqual(["blob:frame-1"]);
    view.unmount();
    expect(urls.freed).toEqual(["blob:frame-1", "blob:frame-2"]);
  } finally {
    urls.restore();
  }
});

test("in StrictMode (effects run twice in development) no address is left behind", () => {
  const urls = blobUrls();
  try {
    const img = createRef<HTMLImageElement>();
    const view = render(
      <StrictMode>
        <LivePicture frame={bytes(1)} alt="" imgRef={img} />
      </StrictMode>,
    );
    const shown = img.current?.getAttribute("src");
    expect(shown?.startsWith("blob:")).toBe(true);
    // Every address made is freed but the one the image shows.
    expect(urls.made.filter((url) => !urls.freed.includes(url))).toEqual([shown as string]);
    view.unmount();
    expect(urls.made.filter((url) => !urls.freed.includes(url))).toEqual([]);
  } finally {
    urls.restore();
  }
});

test("a frame that came as base64 (the realtime socket) shows as a data: address, with nothing to free", () => {
  const urls = blobUrls();
  try {
    const img = createRef<HTMLImageElement>();
    const view = render(
      <LivePicture frame={{ agentId: "a1", seq: 1, data: "/9j/", metadata: META }} alt="" imgRef={img} />,
    );
    expect(img.current?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/");
    view.unmount();
    expect(urls.made).toEqual([]);
    expect(urls.freed).toEqual([]);
  } finally {
    urls.restore();
  }
});
