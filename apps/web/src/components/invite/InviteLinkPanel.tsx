import type { InviteLink } from "@agenteschat/client";
import { useInviteLinks, useMakeInviteLink, useRenewInviteLink, useTurnOffInviteLink } from "@agenteschat/client";
import { formatShortDate, relativeTime } from "@agenteschat/client/lib/format";
import { Button, Dialog, DialogFooter, Icon, Input, SwapLabel } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useCopied } from "./copied";
import "./invite.css";

/**
 * The workspace's invitation link (ADR 0068, 0090) on the invite dialog's link screen: whoever opens it only asks to
 * join, and someone who may invite approves each person. The address to copy, until when it works, "Renovar" (30 more
 * days, the same link) and "Desativar" (with how many waiting requests close with it); "Criar link" when there's
 * none. Links made before links could be shown again are listed to turn off. `copyOnly` (the onboarding's people
 * step, ADR 0162): the link, until when it works and "Copiar link", nothing to renew or turn off.
 */
export function InviteLinkPanel({ copyOnly = false }: { copyOnly?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const links = useInviteLinks(org.id);
  const make = useMakeInviteLink(org.id);
  const renew = useRenewInviteLink(org.id);
  const turnOff = useTurnOffInviteLink(org.id);
  const [copied, copy] = useCopied();
  const [closing, setClosing] = useState<InviteLink | null>(null);
  const all = links.data ?? [];
  const current = all.find((l) => l.url !== null);
  const until = (iso: string) => formatShortDate(i18n.language, iso);
  const turnOffButton = (l: InviteLink) => (
    <Button variant="ghost" size="sm" className="ac-btn--danger" onClick={() => setClosing(l)}>
      {t("members.link.turnOff")}
    </Button>
  );

  return (
    <div className="invite-link">
      {links.isPending ? (
        <LoadingLine width={320} />
      ) : current?.url ? (
        <>
          <div className="invite-link__row">
            <Input
              readOnly
              value={current.url}
              aria-label={t("members.link.title")}
              onFocus={(e) => e.currentTarget.select()}
            />
            {/* The link's own screen: copying it is what the screen is for. */}
            <Button variant="primary" onClick={() => copy(current.id, current.url ?? "")}>
              <SwapLabel
                icon="copy"
                altIcon="check"
                label={t("members.copyLink")}
                alt={t("common.copied")}
                showAlt={copied === current.id}
              />
            </Button>
          </div>
          <p className="invite-link__foot">
            <Icon name="clock" size={14} />
            <span>{t("members.link.until", { date: until(current.expiresAt) })}</span>
            {!copyOnly && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={renew.isPending}
                  onClick={() =>
                    renew.mutate(current.id, {
                      onSuccess: (res) => toast.show(t("members.link.renewed", { date: until(res.expiresAt) })),
                    })
                  }
                >
                  {t("members.link.renew")}
                </Button>
                {turnOffButton(current)}
              </>
            )}
          </p>
        </>
      ) : (
        <div className="invite-link__none">
          <span className="small muted">{t("members.link.none")}</span>
          <Button icon="link" loading={make.isPending} onClick={() => make.mutate()}>
            {t("members.link.make")}
          </Button>
        </div>
      )}
      {!copyOnly &&
        all
          .filter((l) => l.url === null)
          .map((l) => {
            const when = relativeTime(t, i18n.language, l.createdAt);
            return (
              <p key={l.id} className="invite-link__foot">
                <span>
                  {l.createdBy
                    ? t("members.link.earlier", { when, name: l.createdBy, date: until(l.expiresAt) })
                    : t("members.link.earlierNoName", { when, date: until(l.expiresAt) })}
                </span>
                {turnOffButton(l)}
              </p>
            );
          })}
      <Dialog
        open={closing !== null}
        onOpenChange={(open) => !open && setClosing(null)}
        title={t("members.link.turnOffTitle")}
        description={t("members.link.turnOffText", { count: closing?.waiting ?? 0 })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setClosing(null)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={turnOff.isPending}
            onClick={() => closing && turnOff.mutate(closing.id, { onSettled: () => setClosing(null) })}
          >
            {t("members.link.turnOff")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
