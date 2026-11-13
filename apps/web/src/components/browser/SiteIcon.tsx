import { useEffect, useState } from "react";

/** The site as people say it: "www.google.com" → "google.com" (its letter is G, not W). */
export const siteName = (host: string) => host.replace(/^(www|web|m)\./, "");

/**
 * A site's own icon (its `/favicon.ico`, asked without a referrer), or its first letter when it has
 * none or `letterOnly` (an app on the desktop). Same 16px tile either way, so the line never shifts.
 */
export function SiteIcon({ host, letterOnly = false }: { host: string; letterOnly?: boolean }) {
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new site gets a new try
  useEffect(() => setFailed(false), [host]);
  const letter = siteName(host).charAt(0);
  if (letterOnly || failed || !host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    return (
      <span className="brw-site-icon brw-site-icon--letter" aria-hidden="true">
        {letter}
      </span>
    );
  }
  return (
    <span className="brw-site-icon" aria-hidden="true">
      <img
        src={`https://${host}/favicon.ico`}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
