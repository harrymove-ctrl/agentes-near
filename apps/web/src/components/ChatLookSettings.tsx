import { useSetChatPrefs } from "@agenteschat/client";
import {
  CHAT_STYLES,
  CHAT_TEXT_SIZES,
  type ChatOpenAt,
  type ChatStyle,
  type ChatTextSize,
  type ChatTone,
  chatLookOf,
  DEFAULT_TEXT_SIZE,
  facesShown,
  openAtOf,
  textSizeOf,
} from "@agenteschat/client/lib/chat-look";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  type AgentColor,
  Avatar,
  agentGradient,
  Card,
  CardHeader,
  cx,
  InfoHint,
  Message,
  MessageLookContext,
  MessageText,
  Radio,
  RadioGroup,
  Segmented,
} from "@agenteschat/ui";

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** The agent of the samples, the pixel face a DM has. */
const SAMPLE_AGENT = { color: "green" as AgentColor, name: "Ada" };

type Who = "me" | "agent";
interface Line {
  who: Who;
  text: string;
  time: string;
  /** Its place in its author's run. */
  run?: "solo" | "start" | "mid" | "end";
}

/** A few real rows, drawn by the conversation's own code and scaled down. */
function SampleRows({ lines, children }: { lines: Line[]; children?: (line: Line, row: ReactNode) => ReactNode }) {
  const { me } = useOrg();
  return lines.map((line) => {
    const agent = line.who === "agent";
    const run = line.run ?? "solo";
    const row = (
      <Message
        key={line.text}
        agent={agent}
        own={!agent}
        run={run}
        grouped={run === "mid" || run === "end"}
        avatar={
          agent ? (
            <AgentAvatar name={SAMPLE_AGENT.name} appearance={{ color: SAMPLE_AGENT.color }} />
          ) : (
            <Avatar kind="person" name={me.user.name} imageUrl={me.user.image ?? undefined} />
          )
        }
        author={agent ? SAMPLE_AGENT.name : me.user.name}
        time={line.time}
      >
        <MessageText>
          <div className="md md--message">
            <p>{line.text}</p>
          </div>
        </MessageText>
      </Message>
    );
    return children ? children(line, row) : row;
  });
}

function Mini({
  className,
  look,
  size,
  faces = true,
  children,
}: {
  className?: string;
  look: ChatStyle;
  /** Its own Tamanho do texto: the looks' small pictures stay at the default, the size's preview shows the choice. */
  size: ChatTextSize;
  faces?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cx("chat-look__mini", className)} data-text-size={size} aria-hidden="true" inert>
      <span className="channel__messages" data-look={look} data-faces={faces ? undefined : "false"}>
        {children}
      </span>
    </span>
  );
}

/** One choice: its picture over its radio and name, as the cards of a radio group. */
function Choice({
  id,
  value,
  checked,
  title,
  children,
}: {
  id: string;
  value: string;
  checked: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={id} className="ac-option chat-look__card" data-state={checked ? "checked" : "unchecked"}>
      {children}
      <span className="chat-look__foot">
        <Radio value={value} id={id} />
        <span className="ac-option__title">{title}</span>
      </span>
    </label>
  );
}

/**
 * Sua conta › Conversa: how conversations look to me, on every device. Channels and DMs each have their own style (a
 * DM has two speakers, so bubbles say who spoke), Bolhas its Clara or Forte, the size of the words in all of them, and
 * where a conversation opens.
 */
export function ChatLookSettings() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const set = useSetChatPrefs(org.id);
  const toast = useToast();
  const [kind, setKind] = useState<"channels" | "dms">("channels");
  const dm = kind === "dms";
  const prefs = org.chatPrefs;
  // What shows checked is what the conversations use: in a personal workspace, bubbles for channels too (ADR 0159).
  const { style, tone } = chatLookOf(prefs, dm, isPersonal(org));
  const textSize = textSizeOf(prefs);
  const openAt = openAtOf(prefs);
  const save = (patch: Parameters<typeof set.mutate>[0]) =>
    set.mutate(patch, { onError: () => toast.show(t("settings.account.activityFailed")) });
  const mine = agentGradient(dm ? SAMPLE_AGENT.color : "sky")[1];
  // A personal workspace calls its channels group conversations (ADR 0159).
  const toneLabel = dm ? "settings.account.chat.toneDms" : modeKey(org, "settings.account.chat.toneChannels");
  const lookOf = (s: ChatStyle) => ({ style: s, tone, mine, names: !dm, faces: facesShown(s, dm) });
  const talk: Line[] = [
    { who: "me", text: t("settings.account.chat.sample.ask"), time: "14:30" },
    { who: "agent", text: t("settings.account.chat.sample.answer"), time: "14:31" },
    { who: "me", text: t("settings.account.chat.sample.go"), time: "14:32" },
  ];
  const before: Line[] = [
    { who: "me", text: t("settings.account.chat.sample.send"), time: "09:12" },
    { who: "agent", text: t("settings.account.chat.sample.sent"), time: "09:14" },
  ];
  const fresh: Line[] = [
    { who: "agent", text: t("settings.account.chat.sample.new1"), time: "11:02", run: "start" },
    { who: "agent", text: t("settings.account.chat.sample.new2"), time: "11:40", run: "mid" },
    { who: "agent", text: t("settings.account.chat.sample.new3"), time: "13:05", run: "mid" },
    { who: "agent", text: t("settings.account.chat.sample.new4"), time: "13:06", run: "end" },
  ];
  const names: Record<ChatStyle, string> = {
    comfortable: t("settings.account.chat.comfortable"),
    left: t("settings.account.chat.left"),
    bubbles: t("settings.account.chat.bubbles"),
    compact: t("settings.account.chat.compact"),
  };
  const sizes: Record<ChatTextSize, string> = {
    xs: t("settings.account.chat.textXs"),
    sm: t("settings.account.chat.textSm"),
    md: t("settings.account.chat.textMd"),
    lg: t("settings.account.chat.textLg"),
    xl: t("settings.account.chat.textXl"),
  };
  return (
    <Card aria-labelledby="account-chat">
      <CardHeader id="account-chat" title={t("settings.account.chat.title")} />
      <div className="settings-rows">
        <div className="chat-look__group">
          <div className="chat-look__top ac-actline">
            <span className="settings-row__text">
              <span className="ac-hintline">
                <span className="settings-row__label">{t("settings.account.chat.density")}</span>
                <InfoHint name={t("common.about", { label: t("settings.account.chat.density") })}>
                  {t("settings.account.chat.densityHelp")}
                </InfoHint>
              </span>
            </span>
            <Segmented
              size="sm"
              label={t("settings.account.chat.where")}
              value={kind}
              onValueChange={(v) => setKind(v as "channels" | "dms")}
              options={[
                { value: "channels", label: t(modeKey(org, "settings.account.chat.channels")) },
                { value: "dms", label: t("settings.account.chat.dms") },
              ]}
            />
          </div>
          <RadioGroup
            className="chat-look__cards chat-look__cards--styles"
            aria-label={t("settings.account.chat.density")}
            value={style}
            onValueChange={(v: ChatStyle) => save(dm ? { dmStyle: v } : { channelStyle: v })}
          >
            {CHAT_STYLES.map((s) => (
              <Choice key={s} id={`chat-look-${s}`} value={s} checked={s === style} title={names[s]}>
                <MessageLookContext.Provider value={lookOf(s)}>
                  <Mini look={s} size={DEFAULT_TEXT_SIZE} faces={facesShown(s, dm)}>
                    <SampleRows lines={talk} />
                  </Mini>
                </MessageLookContext.Provider>
              </Choice>
            ))}
          </RadioGroup>
        </div>
        {style === "bubbles" && (
          <div className="settings-row ac-actrow">
            <span className="settings-row__text ac-actrow__text">
              <span className="ac-hintline">
                <span className="settings-row__label">{t(toneLabel)}</span>
                <InfoHint
                  name={t("common.about", {
                    label: t(toneLabel),
                  })}
                >
                  {t(dm ? "settings.account.chat.toneDmsHelp" : "settings.account.chat.toneChannelsHelp")}
                </InfoHint>
              </span>
            </span>
            <div className="settings-row__end">
              <Segmented
                size="sm"
                label={t(toneLabel)}
                value={tone}
                onValueChange={(v) => save(dm ? { dmTone: v as ChatTone } : { channelTone: v as ChatTone })}
                options={[
                  { value: "light", label: t("settings.account.chat.toneLight") },
                  { value: "strong", label: t("settings.account.chat.toneStrong") },
                ]}
              />
            </div>
          </div>
        )}
        <div className="chat-look__group">
          <span className="settings-row__text ac-actrow__text">
            <span className="ac-hintline">
              <span className="settings-row__label">{t("settings.account.chat.textSize")}</span>
              <InfoHint name={t("common.about", { label: t("settings.account.chat.textSize") })}>
                {t("settings.account.chat.textSizeHelp")}
              </InfoHint>
            </span>
          </span>
          <Segmented
            size="sm"
            block
            label={t("settings.account.chat.textSize")}
            value={textSize}
            onValueChange={(v) => save({ textSize: v })}
            options={CHAT_TEXT_SIZES.map((s) => ({
              value: s,
              // An A in the step's own size; the default also says its name, the others to screen readers only.
              label: (
                <>
                  <span className="chat-look__a" data-text-size={s} aria-hidden="true">
                    A
                  </span>
                  {s === DEFAULT_TEXT_SIZE ? sizes[s] : <span className="ac-visually-hidden">{sizes[s]}</span>}
                </>
              ),
              title: sizes[s],
            }))}
          />
          <MessageLookContext.Provider value={lookOf(style)}>
            <Mini className="chat-look__mini--real" look={style} size={textSize} faces={facesShown(style, dm)}>
              <SampleRows lines={talk.slice(0, 2)} />
            </Mini>
          </MessageLookContext.Provider>
        </div>
        <div className="chat-look__group">
          <span className="settings-row__text ac-actrow__text">
            <span className="settings-row__label">{t("settings.account.chat.openAt")}</span>
          </span>
          <RadioGroup
            className="chat-look__cards"
            aria-label={t("settings.account.chat.openAt")}
            value={openAt}
            onValueChange={(v: ChatOpenAt) => save({ openAt: v })}
          >
            <MessageLookContext.Provider value={lookOf(style)}>
              <Choice
                id="chat-look-read"
                value="read"
                checked={openAt === "read"}
                title={t("settings.account.chat.openRead")}
              >
                <Mini
                  className="chat-look__mini--read"
                  look={style}
                  size={DEFAULT_TEXT_SIZE}
                  faces={facesShown(style, dm)}
                >
                  <SampleRows lines={before.slice(1)} />
                  <div className="channel__unread">{t("channel.unreadDivider")}</div>
                  <SampleRows lines={fresh} />
                </Mini>
                <span className="chat-look__pill" aria-hidden="true">
                  {t("settings.account.chat.sample.newCount")}
                </span>
              </Choice>
              <Choice
                id="chat-look-latest"
                value="latest"
                checked={openAt === "latest"}
                title={t("settings.account.chat.openLatest")}
              >
                <Mini
                  className="chat-look__mini--end"
                  look={style}
                  size={DEFAULT_TEXT_SIZE}
                  faces={facesShown(style, dm)}
                >
                  <SampleRows lines={fresh} />
                </Mini>
                <span className="chat-look__composer" aria-hidden="true">
                  {t("channel.composerDm", { name: SAMPLE_AGENT.name })}
                </span>
              </Choice>
            </MessageLookContext.Provider>
          </RadioGroup>
        </div>
      </div>
    </Card>
  );
}
