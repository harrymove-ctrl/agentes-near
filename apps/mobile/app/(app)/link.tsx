import { useApi } from "@agenteschat/client";
import { type Href, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { openOwnPage } from "@/features/ai/parts";
import { linkWorkspace, resolveLink } from "@/features/links/app-links";
import { takeLink } from "@/features/links/pending";
import { useColors, useErrorToast } from "@/features/shared/hooks";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { router } from "@/ui/navigation";

/**
 * A link to the website opened in the app (`app/+native-intent.tsx`): switches to the link's workspace when the
 * person is in it, then opens the screen it names (`resolveLink`), in place of this one. A workspace they aren't in
 * opens the address on the website instead. One that can't open (a DM a workspace being deleted won't start) lands on
 * Conversas, saying why.
 */
export default function LinkRoute() {
  const p = useLocalSearchParams<{
    org?: string;
    to?: string;
    thread?: string;
    agent?: string;
    person?: string;
    notification?: string;
    m?: string;
    web?: string;
  }>();
  const { orgId, orgs, setOrgId } = useOrg();
  const api = useApi();
  const c = useColors();
  const failed = useErrorToast();
  const place = linkWorkspace(
    p,
    orgs.map((o) => o.id),
    orgId,
  );
  const wanted = "org" in place ? place.org : orgId;
  const foreign = "web" in place ? place.web : null;
  const { to, thread, agent, person, notification, m } = p;
  useEffect(() => {
    takeLink();
    if (foreign !== null) {
      if (foreign !== "/") openOwnPage(`${serverUrl()}${foreign}`);
      router.replace("/");
      return;
    }
    if (wanted !== orgId) {
      setOrgId(wanted);
      return;
    }
    let alive = true;
    resolveLink(api, orgId, { to, thread, agent, person, notification, m })
      .catch((e: unknown) => {
        if (alive) failed(e);
        return "/";
      })
      .then((href) => {
        if (alive) router.replace(href as Href);
      });
    return () => {
      alive = false;
    };
  }, [api, orgId, wanted, foreign, setOrgId, to, thread, agent, person, notification, m, failed]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}
