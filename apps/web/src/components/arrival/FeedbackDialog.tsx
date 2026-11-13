import { ApiError, useAiStatus, useApi, useAuthConfig } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatBytes } from "@agenteschat/client/lib/files";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import {
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  type Expression,
  Icon,
  modKey,
  PixelSpinner,
  Textarea,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { matchesNow, TOUCH } from "@/hooks/useMatchMedia";
import { contextMenusOn, keepsSystemMenu, openContextMenu, selectedTextAt, setMenuReporter } from "@/lib/context-menu";
import {
  closeFeedback,
  describeElement,
  deviceFacts,
  FILE_LIMITS,
  feedbackOpen,
  onFeedbackOpen,
  openFeedback,
  REPORTABLE,
  type Reported,
  watchErrors,
} from "@/lib/feedback";
import { useToast } from "@/lib/toast";
import { useConnectionStatus } from "@/realtime/context";
import { TeamScene } from "./TeamScene";
import "./arrival.css";

/** As the server takes it (`FEEDBACK_MAX`). */
const MAX = 4000;
/** Facts the app sends, one short of the server's count: it adds the person's role. */
const FACTS = 39;
const MB = 1024 * 1024;
/** How long the agent keeps taking notes after the last key, and its stars after the form is sent. */
const NOTING_MS = 900;
const STARS_MS = 1600;
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/heic,video/mp4,video/quicktime,video/webm";

const ENVELOPE = [
  "###########",
  "##.......##",
  "#.#.....#.#",
  "#..#...#..#",
  "#...#.#...#",
  "#....#....#",
  "#.........#",
  "###########",
];

/** A pixel envelope, drawn in ink on white whatever the theme: it stands on the sky. */
function Envelope({ sent }: { sent: boolean }) {
  return (
    <svg
      className="arrival-envelope"
      data-sent={sent ? "" : undefined}
      viewBox="0 0 11 8"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {ENVELOPE.flatMap((row, y) =>
        [...row].map((cell, x) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={cell === "#" ? "#151514" : "#fff"} />
        )),
      )}
    </svg>
  );
}

/** A file on the form: `id` once the server has it. */
interface Added {
  key: number;
  name: string;
  size: number;
  kind: "image" | "video";
  /** A picture's own bytes, shown small. */
  preview: string | null;
  id: string | null;
}

/**
 * The feedback form (ADR 0160): what the person writes goes by email to whoever runs this server, with what they
 * chose to show (the thing they right-clicked, pictures, a video) and what the app knows of where they are. The
 * right hand stands on the sky with an envelope: it takes notes while the person types, and the envelope flies once
 * it is sent. It only illustrates: no agent reads or sends anything.
 */
export function FeedbackDialog({ reported, onClose }: { reported: Reported | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connection = useConnectionStatus();
  const cloud = useAuthConfig().data?.cloud === true;
  const where = useRouterState({ select: (s) => s.location.pathname });
  const route = useRouterState({ select: (s) => s.matches.at(-1)?.routeId ?? "" });
  const params = useRouterState({ select: (s) => JSON.stringify(s.matches.at(-1)?.params ?? {}) });
  const lead = rightHandOf(dir.agents) ?? dir.agents[0];
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [noting, setNoting] = useState(false);
  const [face, setFace] = useState<Expression>();
  // The thing reported, until the form is sent; its words, until the person takes them out.
  const [about, setAbout] = useState(reported);
  const [quoting, setQuoting] = useState(Boolean(reported?.about.text));
  const [files, setFiles] = useState<Added[]>([]);
  const keys = useRef(0);
  // One id per message: sent again after a failure, the server sends it once.
  const id = useRef(crypto.randomUUID());
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!noting) return;
    const timer = setTimeout(() => setNoting(false), NOTING_MS);
    return () => clearTimeout(timer);
  }, [noting]);
  useEffect(() => {
    if (!sent) return;
    setFace("star");
    const timer = setTimeout(() => setFace("happy"), STARS_MS);
    return () => clearTimeout(timer);
  }, [sent]);
  // Closed without sending: what was uploaded goes now, not in an hour.
  const held = useRef<Added[]>([]);
  held.current = sent ? [] : files;
  useEffect(
    () => () => {
      for (const f of held.current) {
        if (f.preview) URL.revokeObjectURL(f.preview);
        if (f.id) void api.system.dropFeedbackFile(f.id).catch(() => {});
      }
    },
    [api],
  );

  const refuse = (key: "feedback.fileType" | "feedback.fileTooLarge" | "feedback.fileTooMany", file?: File, mb = 0) =>
    toast.show(t(key, { name: file?.name ?? "", mb, images: FILE_LIMITS.images }), "error");
  const add = (list: File[]) => {
    let images = files.filter((f) => f.kind === "image").length;
    let videos = files.filter((f) => f.kind === "video").length;
    for (const file of list) {
      const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
      if (!kind) {
        refuse("feedback.fileType");
        continue;
      }
      const mb = kind === "image" ? FILE_LIMITS.imageMb : FILE_LIMITS.videoMb;
      if (file.size > mb * MB) {
        refuse("feedback.fileTooLarge", file, mb);
        continue;
      }
      if (kind === "image" ? images >= FILE_LIMITS.images : videos >= FILE_LIMITS.videos) {
        refuse("feedback.fileTooMany");
        break;
      }
      if (kind === "image") images++;
      else videos++;
      const key = ++keys.current;
      const preview = kind === "image" && file.type !== "image/heic" ? URL.createObjectURL(file) : null;
      setFiles((all) => [...all, { key, name: file.name, size: file.size, kind, preview, id: null }]);
      api.system.uploadFeedbackFile(file).then(
        (stored) => setFiles((all) => all.map((f) => (f.key === key ? { ...f, id: stored.id, name: stored.name } : f))),
        (error: unknown) => {
          setFiles((all) => all.filter((f) => f.key !== key));
          if (preview) URL.revokeObjectURL(preview);
          const code = error instanceof ApiError ? error.code : "";
          if (code === "feedback.file_type") refuse("feedback.fileType");
          else if (code === "feedback.file_too_large") refuse("feedback.fileTooLarge", file, mb);
          else toast.show(errorText(t, error), "error");
        },
      );
    }
  };
  const remove = (file: Added) => {
    setFiles((all) => all.filter((f) => f.key !== file.key));
    if (file.preview) URL.revokeObjectURL(file.preview);
    if (file.id) void api.system.dropFeedbackFile(file.id).catch(() => {});
  };

  /** What the app knows of where the person is, for whoever reads the email. */
  const facts = (): [string, string][] => {
    const at = JSON.parse(params) as Record<string, string>;
    const agent = at.agentId ? dir.agentById.get(at.agentId) : undefined;
    const rest = Object.entries(at).filter(([k]) => k !== "orgId" && k !== "agentId");
    const list: [string, string][] = [
      ["Route", route],
      ["Workspace mode", org.mode ?? "team"],
      ["Language", i18n.language],
      ["Connection", connection],
      ...(agent
        ? ([
            [
              "Agent",
              `${agent.name} (@${agent.handle}), model ${agent.model}, ${aiStateOf(status.data, agent.id) ?? "state unknown"}`,
            ],
          ] as [string, string][])
        : []),
      ...(at.agentId ? ([["Agent id", at.agentId]] as [string, string][]) : []),
      ...rest.map(([k, v]): [string, string] => [`Param ${k}`.slice(0, 40), String(v)]),
      ...(about?.facts ?? []),
      ...deviceFacts(),
    ];
    return list.filter(([, v]) => v !== "").slice(0, FACTS);
  };

  const send = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api.system.sendFeedback({
        id: id.current,
        text: text.trim(),
        orgId: org.id,
        where,
        app: "web",
        ...(about ? { about: { ...about.about, text: quoting ? about.about.text : undefined } } : {}),
        facts: facts(),
        files: files.flatMap((f) => (f.id ? [f.id] : [])),
      }),
    onError: (error) => toast.show(errorText(t, error), "error"),
    onSuccess: () => {
      id.current = crypto.randomUUID();
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      setSent(true);
    },
  });
  const uploading = files.some((f) => f.id === null);
  const ready = text.trim() !== "" && !send.isPending && !uploading;
  const title = sent ? t("feedback.thanks") : t("feedback.ask");
  const quote = quoting ? (about?.about.text ?? "") : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={480}
      bare
      initialFocus={box}
      // What was typed or added stays until it is sent or given up with a button.
      unsaved={!sent && (text.trim() !== "" || files.length > 0)}
      className="arrival arrival-feedback"
    >
      <div className="arrival-hero">
        <TeamScene
          agents={lead ? [lead] : []}
          lead={lead?.id}
          writing={noting && !sent}
          expression={sent ? face : undefined}
        >
          <Envelope sent={sent} />
        </TeamScene>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <div className="arrival-lede" aria-live="polite">
        <p className="arrival-lede__title" aria-hidden="true">
          {title}
        </p>
        <p className="arrival-lede__text">
          {sent
            ? t("feedback.reply", { email: me.user.email })
            : t(cloud ? "feedback.goesCloud" : "feedback.goesServer")}
        </p>
      </div>
      {sent ? (
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setText("");
              setFiles([]);
              setAbout(null);
              setQuoting(false);
              setSent(false);
            }}
          >
            {t("feedback.another")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) send.mutate();
          }}
        >
          <DialogBody>
            {about && (
              <div className="arrival-about">
                <span className="arrival-about__title">
                  {about.message && about.about.label
                    ? t("feedback.aboutMessage", { name: about.about.label })
                    : about.about.label
                      ? t("feedback.aboutItem", { name: about.about.label })
                      : t("feedback.aboutThis")}
                </span>
                {quote && <blockquote className="arrival-about__text">{quote}</blockquote>}
                {quote && (
                  <button type="button" className="arrival-about__drop" onClick={() => setQuoting(false)}>
                    {t("feedback.aboutDrop")}
                  </button>
                )}
              </div>
            )}
            <Textarea
              ref={box}
              className="arrival-feedback__text"
              rows={about ? 4 : 5}
              maxLength={MAX}
              value={text}
              aria-label={t("feedback.ask")}
              placeholder={t("feedback.placeholder")}
              onChange={(e) => {
                setText(e.target.value);
                setNoting(true);
              }}
              // A screenshot on the clipboard is added as a file.
              onPaste={(e) => {
                const pasted = [...e.clipboardData.files];
                if (pasted.length === 0) return;
                e.preventDefault();
                add(pasted);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) {
                  e.preventDefault();
                  send.mutate();
                }
              }}
            />
            {files.length > 0 && (
              <ul className="arrival-files">
                {files.map((f) => (
                  <li key={f.key}>
                    {f.preview ? (
                      <img className="arrival-files__thumb" src={f.preview} alt="" />
                    ) : (
                      <span className="arrival-files__thumb" aria-hidden="true">
                        <Icon name={f.kind === "video" ? "play" : "image"} />
                      </span>
                    )}
                    <span className="arrival-files__name">{f.name}</span>
                    <span className="arrival-files__size">
                      {f.id === null ? (
                        <PixelSpinner size={14} label={t("feedback.uploading", { name: f.name })} />
                      ) : (
                        formatBytes(i18n.language, f.size)
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="close"
                      aria-label={t("feedback.removeFile", { name: f.name })}
                      onClick={() => remove(f)}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className="arrival-feedback__attach">
              <input
                ref={picker}
                type="file"
                hidden
                multiple
                accept={ACCEPT}
                onChange={(e) => {
                  add([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              <Button type="button" variant="ghost" size="sm" icon="attach" onClick={() => picker.current?.click()}>
                {t("feedback.attach")}
              </Button>
              <span className="arrival-feedback__limits">
                {t("feedback.filesHint", {
                  images: FILE_LIMITS.images,
                  imageMb: FILE_LIMITS.imageMb,
                  videoMb: FILE_LIMITS.videoMb,
                  days: FILE_LIMITS.days,
                })}
              </span>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon="send"
              kbd={[modKey(), "↵"]}
              disabled={!ready}
              loading={send.isPending}
            >
              {t("feedback.send")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/**
 * The feedback form's one place in the workspace, where the server takes feedback: it draws the form when asked for
 * (`openFeedback`), keeps the app's last errors for it, and gives every right-click menu its report entry.
 */
export function FeedbackHost() {
  const { t } = useTranslation();
  const on = useAuthConfig().data?.feedback === true;
  const open = useSyncExternalStore(onFeedbackOpen, feedbackOpen, () => null);
  useEffect(() => {
    if (!on) return;
    watchErrors();
    setMenuReporter({
      label: t("feedback.report"),
      run: (target, selected) => openFeedback(describeElement(target, selected)),
    });
    // A message or a card with no menu of its own gets one, with that entry alone. Selected text, links, pictures
    // and fields keep the browser's menu, as everywhere; so does a long press on a touch screen.
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || !contextMenusOn() || keepsSystemMenu(e.target)) return;
      if ((e as PointerEvent).pointerType === "touch" || matchesNow(TOUCH)) return;
      if (!(e.target instanceof Element) || !e.target.closest(REPORTABLE) || selectedTextAt(e.target)) return;
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, [], e.target);
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      setMenuReporter(null);
    };
  }, [on, t]);
  // Leaving the workspace leaves the form: it never opens by itself in the next one.
  useEffect(() => closeFeedback, []);
  if (!on || !open) return null;
  return <FeedbackDialog key={open.n} reported={open.reported} onClose={closeFeedback} />;
}

/**
 * The way to the feedback form: a quiet row at the bottom of the sidebar, marked Beta. Only where the server takes
 * feedback (`FEEDBACK_EMAIL`): elsewhere there is no row.
 */
export function FeedbackMark() {
  const { t } = useTranslation();
  if (useAuthConfig().data?.feedback !== true) return null;
  return (
    <div className="sidebar__feedback">
      <button type="button" className="sidebar__item" aria-label={t("feedback.open")} onClick={() => openFeedback()}>
        <Icon name="message" />
        <span className="sidebar__item-label">{t("feedback.open")}</span>
        <Chip>{t("feedback.mark")}</Chip>
      </button>
    </div>
  );
}
