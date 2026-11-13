import { keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { router } from "@/ui/navigation";
import { requestComposerText } from "../chat/composer-request";
import { chatHref } from "../links/logic";
import { useErrorToast, useOrgId } from "../shared/hooks";
import { closeSheetsAndOpen } from "./parts";

/**
 * Opens (or creates) the direct conversation with an agent or a person, closing the sheets on the way. `compose`: the
 * conversation opens ready to type (its composer focused), with `text` in it when given. `replace`: the screen it is opened from gives way to it
 * ("New", pushed over the tabs: back from the conversation goes to the tabs, with no pop and push between).
 */
export function useOpenDm() {
  const api = useApi();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const failed = useErrorToast();
  return useCallback(
    (
      target: { agentId: string } | { userId: string },
      how: { compose?: boolean; text?: string; replace?: boolean } = {},
    ) =>
      api.dms
        .open(orgId, target)
        .then(({ channelId }) => {
          void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
          if (how.compose) requestComposerText(channelId, how.text ?? "");
          if (how.replace) router.replace(chatHref(channelId));
          else closeSheetsAndOpen(chatHref(channelId));
        })
        .catch(failed),
    [api, orgId, qc, failed],
  );
}
