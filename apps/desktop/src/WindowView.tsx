import { Button, EmptyState } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "./app";
import { IPHONE_SETUP_PREF } from "./control/devices";
import { PAIR_OFFER_PREF, type PairTarget, targetKey } from "./control/pair";
import { PREPARE_PREF } from "./control/permissions";
import { readPref, useOnShown, writePref } from "./hooks";
import type { WindowName } from "./host/types";
import { FirstRun } from "./windows/FirstRun";
import { IphoneSetup } from "./windows/IphoneSetup";
import { Notch } from "./windows/Notch";
import { Framed, PairOffer, Prepare } from "./windows/Pair";
import { Popover } from "./windows/Popover";
import { Prefs } from "./windows/Prefs";

/** One bundle, four windows: the Tauri window's label picks the screen. */
export function WindowView({ name }: { name: WindowName }) {
  useEffect(() => {
    document.body.dataset.window = name;
  }, [name]);
  if (name === "welcome") return <Welcome />;
  if (name === "prefs") return <Prefs />;
  if (name === "notch") return <Notch />;
  return <Popover />;
}

type PrepareFor = { org: string; server: string; resumed?: boolean };

/**
 * Preferences asked for the iPhone setup (`IPHONE_SETUP_PREF`), the popover offers this computer to a workspace
 * (`PAIR_OFFER_PREF`) or prepares this Mac after the site paired it (`PREPARE_PREF`), each cleared once it shows: there,
 * else the first run. A Prepare step macOS quit the app in the middle of comes back first (`resumed`).
 */
function Welcome() {
  const host = useHost();
  const [iphone, setIphone] = useState(() => readPref(IPHONE_SETUP_PREF, false));
  const [offer, setOffer] = useState(() => readPref<PairTarget | null>(PAIR_OFFER_PREF, null));
  const [prepare, setPrepare] = useState(() => readPref<PrepareFor | null>(PREPARE_PREF, null));
  // Until the app says whether a setup waits: nothing, so the first run never flashes before it.
  const [resuming, setResuming] = useState(true);
  useEffect(() => {
    let live = true;
    host
      .setupState()
      .then((s) => {
        if (live && s?.step === "prepare" && s.resumed) setPrepare({ org: s.org, server: s.server, resumed: true });
      })
      .catch(() => {})
      .finally(() => live && setResuming(false));
    return () => {
      live = false;
    };
  }, [host]);
  useEffect(() => {
    if (iphone) writePref(IPHONE_SETUP_PREF, false);
  }, [iphone]);
  useEffect(() => {
    if (offer) writePref(PAIR_OFFER_PREF, null);
  }, [offer]);
  useEffect(() => {
    if (prepare) writePref(PREPARE_PREF, null);
  }, [prepare]);
  // Cleared here too: asked again while it already shows, the state doesn't change and the effect wouldn't run.
  useOnShown("welcome", () => {
    const asked = readPref<PairTarget | null>(PAIR_OFFER_PREF, null);
    if (asked) {
      writePref(PAIR_OFFER_PREF, null);
      setOffer(asked);
    }
    const ready = readPref<PrepareFor | null>(PREPARE_PREF, null);
    if (ready) {
      writePref(PREPARE_PREF, null);
      setPrepare(ready);
    }
    if (!readPref(IPHONE_SETUP_PREF, false)) return;
    writePref(IPHONE_SETUP_PREF, false);
    setIphone(true);
  });
  const hide = () => void host.hideWindow("welcome").catch(() => {});
  if (iphone) return <IphoneSetup onClose={hide} />;
  if (prepare)
    return (
      <Framed>
        <Prepare
          key={`${prepare.server} ${prepare.org}`}
          org={prepare.org}
          server={prepare.server}
          resumed={prepare.resumed}
          onClose={() => {
            setPrepare(null);
            hide();
          }}
        />
      </Framed>
    );
  if (resuming) return null;
  if (offer)
    return (
      <PairOffer
        key={targetKey(offer)}
        target={offer}
        onClose={() => {
          setOffer(null);
          hide();
        }}
      />
    );
  return <FirstRun />;
}

/** A window that broke while drawing (main.tsx's boundary): what happened, and drawn again from the start. */
export function WindowError() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="alert"
      actions={
        <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
          {t("desktop.common.retry")}
        </Button>
      }
    >
      {t("desktop.common.error")}
    </EmptyState>
  );
}
