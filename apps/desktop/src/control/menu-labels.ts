import type { TFunction } from "i18next";

/** The longest label Rust takes (`app_menu_set` in menus.rs refuses the whole set past it). */
export const MAX_MENU_LABEL = 120;

/**
 * Everything Rust shows in the app's language: the menu bar, the tray's own menu on Windows and Linux (the
 * server here's line in it too), the system dialog before a page pairs this computer and the server here's
 * notifications (and their Stop). `{org}`, `{host}` and `{version}` are left for Rust to fill in.
 */
export function menuLabels(t: TFunction): Record<string, string> {
  return {
    ...(t("desktop.menu", { returnObjects: true }) as Record<string, string>),
    serversAdd: t("desktop.servers.add"),
    serversManage: t("desktop.servers.manage"),
    trayOpen: t("desktop.tray.open"),
    trayPrefs: t("desktop.tray.prefs"),
    trayPause: t("desktop.tray.pause"),
    trayPause1h: t("desktop.tray.pause1h"),
    trayPauseTomorrow: t("desktop.tray.pauseTomorrow"),
    trayPauseManual: t("desktop.tray.pauseManual"),
    trayResume: t("desktop.tray.resume"),
    pairTitle: t("desktop.pair.title", { org: "{org}" }),
    pairBody: t("desktop.pair.body", { host: "{host}" }),
    pairAllow: t("desktop.pair.allow"),
    pairNotNow: t("desktop.pair.notNow"),
    serverTitle: t("desktop.server.title"),
    serverRunning: t("desktop.server.running"),
    serverStarting: t("desktop.server.starting"),
    serverStopped: t("desktop.server.stopped"),
    serverFailing: t("desktop.server.failing"),
    serverStart: t("desktop.server.start"),
    serverStop: t("desktop.server.stop"),
    // The Mac's Servers › this computer's server (menus.rs `here_menu`, ADR 0158).
    serverOpen: t("desktop.servers.open"),
    serverRestart: t("desktop.server.restart"),
    serverStop1h: t("desktop.server.stopFor1h"),
    serverStopHeld: t("desktop.server.stopUntilStart"),
    serverStartNow: t("desktop.server.startNow"),
    hereStopped: t("desktop.server.stoppedBanner"),
    hereStoppedBody: t("desktop.server.stoppedBody"),
    hereFailing: t("desktop.server.failingBanner"),
    hereFailingBody: t("desktop.server.failingBody"),
    hereRestarted: t("desktop.server.restartedBanner"),
    hereRestartedBody: t("desktop.server.restartedBody"),
    hereBack: t("desktop.server.updateBack", { version: "{version}" }),
    hereBackBody: t("desktop.server.updateBackBody"),
    setupFailed: t("desktop.here.notifyFailed"),
    setupFailedBody: t("desktop.here.notifyFailedBody"),
    // Another server's new notifications (workspaces.rs, ADR 0154): "{count}" is left for Rust.
    serversCloud: t("desktop.servers.cloud"),
    // The app's own windows by name, so the Dock's list never shows three "agentes.chat".
    windowWelcome: t("desktop.windowTitle.welcome"),
    windowPrefs: t("desktop.windowTitle.prefs"),
    workspaceNewsOne: t("desktop.servers.newsOne"),
    workspaceNewsMany: t("desktop.servers.newsMany", { n: "{count}" }),
    // The Stop on the notification of a phone someone's agent uses (main_window.rs `show_notice`).
    notifyStop: t("devices.stop"),
  };
}
