import { useMemo } from "react";
import { appHeaders, lastCookie } from "@/lib/auth";
import { type PhotoSource, photoSource } from "@/lib/photo";
import { serverUrl } from "@/lib/server";

/** A person's photo (`avatarUrl` or `image`) as the avatar loads it, with the session when it is ours. */
export function usePersonPhoto(url: string | null | undefined): PhotoSource | null {
  // Stable per URL, so the image isn't fetched again on every render.
  return useMemo(() => photoSource(url, serverUrl(), appHeaders(lastCookie())), [url]);
}
