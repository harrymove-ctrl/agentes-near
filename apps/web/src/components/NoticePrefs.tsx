import { type NoticeCategory, useNoticePrefs, useSetNoticePref } from "@agenteschat/client";
import { Card, CardHeader, Chip, Icon, type IconName, InfoHint, Switch } from "@agenteschat/ui";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useBrowserNotices } from "@/components/WebPush";
import { inDesktopApp } from "@/lib/desktop";
import { useToast } from "@/lib/toast";

const ICONS: Record<NoticeCategory, IconName> = {
  waiting: "waiting",
  replies: "reply",
  mentions: "message",
  threads: "thread",
  tasks: "issues",
  routines: "routines",
  computers: "computer",
  reactions: "smile",
};

/**
 * Configurações › Notificações (ADR 0071 §8): where notifications reach me (this browser, my phone, the Mac app),
 * then one switch per kind for this workspace. The inbox keeps everything; these choose what becomes a push or a
 * banner.
 */
export function NoticePrefsSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const prefs = useNoticePrefs(org.id);
  const set = useSetNoticePref(org.id);
  const browser = useBrowserNotices();
  const phones = prefs.data?.phones ?? 0;

  return (
    <>
      <Card aria-labelledby="notice-where">
        <CardHeader id="notice-where" icon="bell" title={t("noticePrefs.whereTitle")} />
        <div className="settings-rows">
          {browser.shown && !inDesktopApp() && (
            <PrefRow
              id="notice-browser"
              icon="globe"
              label={t("noticePrefs.browser")}
              hint={browser.blocked ? undefined : t("shell.browserNoticesHint")}
              status={browser.blocked && t("shell.browserNoticesBlocked")}
              control={
                <Switch
                  checked={browser.on}
                  onCheckedChange={browser.change}
                  disabled={browser.blocked || browser.busy}
                  aria-label={t("noticePrefs.browser")}
                />
              }
            />
          )}
          <PrefRow
            id="notice-phone"
            icon="phone"
            label={t("noticePrefs.phone")}
            hint={phones > 0 ? t("noticePrefs.phoneOn") : undefined}
            status={phones > 0 ? undefined : t("noticePrefs.phoneOff")}
            control={
              prefs.data &&
              (phones > 0 ? (
                <Chip icon="check" tone="done">
                  {t("noticePrefs.on")}
                </Chip>
              ) : (
                <Chip>{t("noticePrefs.off")}</Chip>
              ))
            }
          />
          <PrefRow id="notice-mac" icon="computerMac" label={t("noticePrefs.mac")} hint={t("noticePrefs.macHelp")} />
        </div>
      </Card>

      <Card aria-labelledby="notice-what">
        <CardHeader id="notice-what" icon="preference" title={t("noticePrefs.whatTitle")} />
        {prefs.data ? (
          <div className="settings-rows">
            {prefs.data.categories.map((c) => (
              <PrefRow
                key={c.id}
                id={`notice-${c.id}`}
                icon={ICONS[c.id]}
                label={t(`noticePrefs.category.${c.id}.title`)}
                hint={t(`noticePrefs.category.${c.id}.help`)}
                control={
                  <Switch
                    checked={c.on}
                    onCheckedChange={(on) =>
                      set.mutate(
                        { category: c.id, on },
                        { onError: () => toast.show(t("noticePrefs.failed"), "error") },
                      )
                    }
                    aria-label={t(`noticePrefs.category.${c.id}.title`)}
                  />
                }
              />
            ))}
          </div>
        ) : prefs.isError ? (
          <p className="muted">{t("noticePrefs.loadFailed")}</p>
        ) : (
          <LoadingLine width={320} />
        )}
      </Card>
    </>
  );
}

/**
 * One line of the person's own settings: its icon (or their face), its name with an ⓘ for what it does (`hint`), then
 * its control, centred on each other. Under the name only what must stay in sight (`status`: why the control is off,
 * the value a line opens to); a value before the control (`value`: the plan it uses). With `onOpen` the whole line is a
 * button that opens something, a chevron at its end, and it takes no ⓘ (a button can't hold one). With a switch a press
 * anywhere on the line toggles it, its name the switch's label. Several controls (`actions`: a day, an hour and Parar de
 * receber) go under the words when they don't fit beside them, from the words' edge; one control keeps its place.
 */
export function PrefRow({
  id,
  icon,
  lead,
  label,
  hint,
  status,
  value,
  control,
  actions,
  onOpen,
}: {
  id: string;
  icon?: IconName;
  /** In place of the icon: the person's face. */
  lead?: ReactNode;
  label: string;
  /** What the setting does, behind an ⓘ beside the name: plain sentences only. */
  hint?: ReactNode;
  /** What must stay in sight under the name: why the control is off, what it waits on, what the line opens to. */
  status?: ReactNode;
  /** A value before the control (a plan's logo and name). */
  value?: ReactNode;
  control?: ReactNode;
  /** In place of `control`: several controls or buttons, which wrap under the words rather than keep their place. */
  actions?: ReactNode;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const toggle = isValidElement(control) && control.type === Switch;
  const switchId = toggle ? ((control.props as { id?: string }).id ?? `${id}-switch`) : undefined;
  const described = [hint && !onOpen && `${id}-help`, status && `${id}-status`].filter(Boolean).join(" ");
  const end = toggle
    ? cloneElement(control as ReactElement<{ id?: string; "aria-describedby"?: string }>, {
        id: switchId,
        "aria-describedby": described || undefined,
      })
    : control;
  const name = toggle ? (
    // The switch's label, stretched over the line (`.settings-row__hit`), so a press on its words or its room toggles.
    <label htmlFor={switchId} className="settings-row__label settings-row__hit">
      {label}
    </label>
  ) : (
    <span className="settings-row__label">{label}</span>
  );
  const face = (
    <span className="settings-row__icon" aria-hidden="true">
      {lead ?? (icon && <Icon name={icon} size={16} />)}
    </span>
  );
  const words = (
    <span className={actions ? "settings-row__text" : "settings-row__text ac-actrow__text"}>
      {hint && !onOpen ? (
        <span className="ac-hintline">
          {name}
          <InfoHint id={`${id}-help`} name={t("common.about", { label })}>
            {hint}
          </InfoHint>
        </span>
      ) : (
        name
      )}
      {status && (
        <span className="settings-row__status" id={`${id}-status`}>
          {status}
        </span>
      )}
    </span>
  );
  // The icon and the words are the line's words: controls under them start from the row's edge, never leaving the
  // icon a column beside three lines.
  if (actions)
    return (
      <div className="settings-row settings-row--lead settings-row--acts ac-actline">
        <span className="settings-row__lead">
          {face}
          {words}
        </span>
        <span className="settings-row__end">{actions}</span>
      </div>
    );
  const body = (
    <>
      {face}
      {words}
      {value && <span className="settings-row__value">{value}</span>}
      {onOpen ? (
        <Icon name="chevronRight" size={16} className="settings-row__chevron" />
      ) : (
        end && <div className="settings-row__end">{end}</div>
      )}
    </>
  );
  if (onOpen)
    return (
      <button type="button" className="settings-row ac-actrow settings-row--lead settings-row--open" onClick={onOpen}>
        {body}
      </button>
    );
  return (
    <div
      className={
        toggle
          ? "settings-row ac-actrow settings-row--lead settings-row--toggle"
          : "settings-row ac-actrow settings-row--lead"
      }
    >
      {body}
    </div>
  );
}
