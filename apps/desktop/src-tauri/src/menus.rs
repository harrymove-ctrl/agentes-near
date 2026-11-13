//! The app's menus: the menu bar (with the servers it opens), the tray's own menu on Windows and Linux
//! (tray.rs), and the site's right-click menu when the person chose the system's look. The popover sends
//! every label in the app's language (`app_menu_set`, the pairing dialog's too); the site sends what its
//! right-click menu has (`context_menu`) and the system draws it. What the site handles goes back to it
//! through `window.__agentesMenu(action)` and `window.__agentesContextMenu(token, id)`, a call into the page,
//! never a command the page can make; the rest stays here (servers, Preferences, updates, zoom, quit).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{AboutMetadataBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

use crate::main_window;

/// Menu bar items the site handles, with their shortcut (the site's own keys win: it handles them first).
const SITE_ACTIONS: &[(&str, Option<&str>)] = &[
    ("newChannel", Some("CmdOrCtrl+Shift+N")),
    ("newAgent", None),
    ("search", Some("CmdOrCtrl+K")),
    ("back", Some("CmdOrCtrl+[")),
    ("forward", Some("CmdOrCtrl+]")),
    ("toggleSidebar", Some("CmdOrCtrl+\\")),
    ("goHome", Some("CmdOrCtrl+1")),
    ("goWaiting", Some("CmdOrCtrl+2")),
    ("goTasks", Some("CmdOrCtrl+3")),
    ("goWiki", Some("CmdOrCtrl+4")),
    ("goDrive", Some("CmdOrCtrl+5")),
    ("orgSettings", Some("CmdOrCtrl+Shift+,")),
];

/// Zoom steps of the main window (⌘+ / ⌘− / ⌘0).
const ZOOM_STEPS: &[f64] = &[0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75];

/// Where the main window's zoom is (`None`: 100%).
#[derive(Default)]
pub struct Zoom(Mutex<Option<usize>>);

/// The popover's labels and the site's organizations: the menu is built again when either changes.
#[derive(Default)]
pub struct MenuParts {
    labels: Mutex<HashMap<String, String>>,
    orgs: Mutex<Vec<(String, String)>>,
}

/// The labels the popover sent last (empty before it did).
pub fn labels(app: &AppHandle) -> HashMap<String, String> {
    app.state::<MenuParts>().labels.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// An organization's name from the site's last list (the Go menu's).
pub fn org_name(app: &AppHandle, id: &str) -> Option<String> {
    let parts = app.state::<MenuParts>();
    let orgs = parts.orgs.lock().unwrap_or_else(|e| e.into_inner());
    orgs.iter().find(|(o, _)| o == id).map(|(_, name)| name.clone())
}

/// The server list changed (chosen, removed): the menus that list them.
pub fn servers_changed(app: &AppHandle) {
    let _ = rebuild(app);
    crate::tray::refresh(app);
}

/// The zoom kept from last time (window_state.rs): applied when the window is made.
pub fn restore_zoom(app: &AppHandle, step: usize) -> f64 {
    let step = step.min(ZOOM_STEPS.len() - 1);
    *app.state::<Zoom>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(step);
    ZOOM_STEPS[step]
}

pub fn current_zoom(app: &AppHandle) -> f64 {
    let base = ZOOM_STEPS.iter().position(|z| *z == 1.0).unwrap_or(0);
    let at = app.state::<Zoom>().0.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or(base);
    ZOOM_STEPS[at]
}

impl Zoom {
    /// One step in or out (`by` ±1), or back to 100% (`by` 0).
    fn step(&self, by: i32) -> f64 {
        let base = ZOOM_STEPS.iter().position(|z| *z == 1.0).unwrap_or(0);
        let mut at = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let next = if by == 0 {
            base
        } else {
            (at.unwrap_or(base) as i32 + by).clamp(0, ZOOM_STEPS.len() as i32 - 1) as usize
        };
        *at = Some(next);
        ZOOM_STEPS[next]
    }
}

/// The page's own call for `action` (a fixed id, quoted as JSON).
fn site_call(function: &str, args: &[&str]) -> String {
    let args: Vec<String> = args.iter().map(|a| serde_json::to_string(a).unwrap_or_default()).collect();
    format!("window.{function}?.({})", args.join(","))
}

/// A choice for the site. From the menu bar it also brings the window forward (⌘K from Preferences lands in
/// the window, not in a hidden page).
fn to_site(app: &AppHandle, js: String) {
    if let Some(page) = app.get_webview(main_window::LABEL) {
        let _ = page.eval(js);
        let _ = main_window::open(app, None);
    } else {
        // Nothing open to act on: the window comes, the person asks again from it.
        let _ = main_window::open(app, None);
    }
}

/// A menu bar or right-click choice (`on_menu_event` in lib.rs).
pub fn on_event(app: &AppHandle, id: &str) {
    if let Some(rest) = id.strip_prefix("ctx:") {
        if let (Some((token, item)), Some(page)) = (rest.split_once(':'), app.get_webview(main_window::LABEL)) {
            let _ = page.eval(site_call("__agentesContextMenu", &[token, item]));
        }
        return;
    }
    if let Some(org) = id.strip_prefix("org:") {
        to_site(app, site_call("__agentesMenu", &["org", org]));
        return;
    }
    // A server of the list, by its place in it: the main window opens there.
    if let Some(n) = id.strip_prefix("server:").and_then(|n| n.parse::<usize>().ok()) {
        if let Some(url) = crate::servers::get(app).servers.get(n).and_then(|s| s.parse().ok()) {
            let _ = main_window::show_url(app, url);
        }
        return;
    }
    let Some(action) = id.strip_prefix("app:") else { return };
    match action {
        "prefs" => {
            let _ = crate::present(app, "prefs");
        }
        "serversAdd" => {
            let _ = crate::present(app, "welcome");
        }
        "open" => crate::open_app(app),
        // The tray's line for the server here (Windows and Linux).
        "hereStart" => crate::local_server::start_by_hand(app),
        "hereStop" => {
            let app = app.clone();
            std::thread::spawn(move || crate::local_server::hold_stopped(&app, None));
        }
        // The Mac's Servers › this computer's server (ADR 0158): an hour, then it starts again by itself.
        "hereStop1h" => {
            let app = app.clone();
            std::thread::spawn(move || crate::local_server::hold_stopped(&app, Some(60)));
        }
        // The popover owns updates, quitting (it asks first while agents are working), access requests, the
        // Servers tab and pausing.
        "updates" | "quit" | "requests" | "thisMac" | "servers" | "pause1h" | "pauseTomorrow" | "pauseManual"
        | "resume" | "hereRestart" => {
            let _ = app.emit_to("popover", "menu://action", action);
        }
        "reload" => to_site(app, "location.reload()".into()),
        "print" => {
            if let Some(page) = app.get_webview(main_window::LABEL) {
                let _ = page.print();
            }
        }
        "zoomIn" | "zoomOut" | "zoomReset" => {
            let by = match action {
                "zoomIn" => 1,
                "zoomOut" => -1,
                _ => 0,
            };
            let scale = app.state::<Zoom>().step(by);
            if let Some(page) = app.get_webview(main_window::LABEL) {
                let _ = page.set_zoom(scale);
            }
            let step = ZOOM_STEPS.iter().position(|z| *z == scale);
            crate::window_state::update(app, |saved| saved.zoom = step);
            main_window::fit_page(app);
        }
        _ if SITE_ACTIONS.iter().any(|(a, _)| *a == action) => to_site(app, site_call("__agentesMenu", &[action])),
        _ => {}
    }
}

/// The menu bar, with the popover's labels (missing ones fall back to the key, never empty).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_app_menu(
    app: &AppHandle,
    labels: &HashMap<String, String>,
    orgs: &[(String, String)],
) -> tauri::Result<Menu<tauri::Wry>> {
    let l = |key: &str| labels.get(key).map(String::as_str).unwrap_or(key).to_string();
    let site = |key: &str| -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
        let shortcut = SITE_ACTIONS.iter().find(|(a, _)| *a == key).and_then(|(_, s)| *s);
        let mut item = MenuItemBuilder::with_id(format!("app:{key}"), l(key));
        if let Some(s) = shortcut {
            item = item.accelerator(s);
        }
        item.build(app)
    };
    let own = |key: &str, shortcut: Option<&str>| -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
        let mut item = MenuItemBuilder::with_id(format!("app:{key}"), l(key));
        if let Some(s) = shortcut {
            item = item.accelerator(s);
        }
        item.build(app)
    };
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadataBuilder::new()
        .name(Some(app.package_info().name.clone()))
        .version(Some(app.package_info().version.to_string()))
        // The license's required attribution (NOTICE, AGPL-3.0 section 7(b)); never removed.
        .copyright(Some(
            "Based on agentes.chat by Codari Global, LLC\n\
             Copyright © 2026 Codari Global, LLC and contributors\n\
             AGPL-3.0-only, with no warranty",
        ))
        .build();

    let app_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
        .about_with_text(l("about"), Some(about))
        .item(&own("updates", None)?)
        .item(&sep()?)
        .item(&own("prefs", Some("CmdOrCtrl+,"))?)
        .item(&servers_menu(app, &l)?)
        .item(&site("orgSettings")?)
        .item(&sep()?)
        .services_with_text(l("services"))
        .item(&sep()?)
        .hide_with_text(l("hide"))
        .hide_others_with_text(l("hideOthers"))
        .show_all_with_text(l("showAll"))
        .item(&sep()?)
        .item(&own("quit", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, l("file"))
        .item(&site("newChannel")?)
        .item(&site("newAgent")?)
        .item(&sep()?)
        .item(&site("search")?)
        .item(&sep()?)
        .item(&own("print", Some("CmdOrCtrl+P"))?)
        .item(&sep()?)
        .close_window_with_text(l("closeWindow"))
        .build()?;
    let edit = SubmenuBuilder::new(app, l("edit"))
        .undo_with_text(l("undo"))
        .redo_with_text(l("redo"))
        .item(&sep()?)
        .cut_with_text(l("cut"))
        .copy_with_text(l("copy"))
        .paste_with_text(l("paste"))
        .select_all_with_text(l("selectAll"))
        .build()?;
    let view = SubmenuBuilder::new(app, l("view"))
        .item(&site("back")?)
        .item(&site("forward")?)
        .item(&own("reload", Some("CmdOrCtrl+R"))?)
        .item(&sep()?)
        .item(&site("toggleSidebar")?)
        .item(&sep()?)
        .item(&own("zoomIn", Some("CmdOrCtrl+="))?)
        .item(&own("zoomOut", Some("CmdOrCtrl+-"))?)
        .item(&own("zoomReset", Some("CmdOrCtrl+0"))?)
        .item(&sep()?)
        .fullscreen_with_text(l("fullscreen"))
        .build()?;
    let mut go = SubmenuBuilder::new(app, l("go"))
        .item(&site("goHome")?)
        .item(&site("goWaiting")?)
        .item(&site("goTasks")?)
        .item(&site("goWiki")?)
        .item(&site("goDrive")?);
    // The person's organizations, ⌘⌥1–9 for the first nine (Slack's ⌘1–9 for workspaces; ⌘1–5 are sections).
    if !orgs.is_empty() {
        go = go.item(&sep()?);
        for (n, (id, name)) in orgs.iter().enumerate() {
            let mut item = MenuItemBuilder::with_id(format!("org:{id}"), name);
            if n < 9 {
                item = item.accelerator(format!("CmdOrCtrl+Alt+{}", n + 1));
            }
            go = go.item(&item.build(app)?);
        }
    }
    let go = go.build()?;
    let mut window = SubmenuBuilder::new(app, l("window"))
        .minimize_with_text(l("minimize"))
        .maximize_with_text(l("zoom"))
        .item(&sep()?);
    // This computer's own items only while agents work on it.
    if app.state::<crate::runners::Runners>().any_paired() {
        window = window.item(&own("thisMac", None)?).item(&own("requests", None)?).item(&sep()?);
    }
    let window = window.bring_all_to_front_with_text(l("bringAllToFront")).build()?;
    // Empty on purpose: the Mac puts its search of every menu item there.
    let help = SubmenuBuilder::new(app, l("help")).build()?;
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_as_windows_menu_for_nsapp();
        let _ = help.set_as_help_menu_for_nsapp();
    }
    let items: [&Submenu<tauri::Wry>; 7] = [&app_menu, &file, &edit, &view, &go, &window, &help];
    Menu::with_items(app, &items.map(|s| s as &dyn tauri::menu::IsMenuItem<tauri::Wry>))
}

const MAX_LABEL: usize = 120;

/// "Servers ›": the servers this app opens (✓ the one open now), then Add a server… and Manage servers….
pub fn servers_menu(
    app: &AppHandle,
    l: &dyn Fn(&str) -> String,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let file = crate::servers::get(app);
    let mut menu = SubmenuBuilder::new(app, l("servers"));
    for (n, server) in file.servers.iter().enumerate() {
        // Named as everywhere else in the app: agentes.chat, the server here by what it is, any other by its host.
        let here = crate::local_server::is_here(app, server).then(|| l("serverTitle"));
        let name = crate::workspaces::server_name(server, "agentes.chat", here.as_deref());
        let current = file.current.as_deref() == Some(server.as_str());
        if here.is_some() {
            menu = menu.item(&here_menu(app, l, &name, n, current)?);
            continue;
        }
        let item = tauri::menu::CheckMenuItemBuilder::with_id(format!("server:{n}"), name).checked(current).build(app)?;
        menu = menu.item(&item);
    }
    if !file.servers.is_empty() {
        menu = menu.separator();
    }
    menu.item(&MenuItemBuilder::with_id("app:serversAdd", l("serversAdd")).build(app)?)
        .item(&MenuItemBuilder::with_id("app:servers", l("serversManage")).build(app)?)
        .build()
}

/// What the server here's submenu says of it: its state, and whether Stop (running or on its way) or Start fits.
pub fn here_state(phase: crate::local_server::Phase) -> (&'static str, bool) {
    use crate::local_server::Phase;
    match phase {
        Phase::Running => ("serverRunning", true),
        Phase::Starting | Phase::Updating | Phase::Restarting => ("serverStarting", true),
        Phase::Failing => ("serverFailing", false),
        Phase::Stopped | Phase::Off => ("serverStopped", false),
    }
}

/// "Servers › O agentes.chat neste Mac ›" (ADR 0158): its state, Open (✓ when the window is on it), then Restart,
/// Stop for an hour and Stop until Start, or Start now.
fn here_menu(
    app: &AppHandle,
    l: &dyn Fn(&str) -> String,
    name: &str,
    n: usize,
    current: bool,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let (state, up) = here_state(crate::local_server::phase(app));
    let mut menu = SubmenuBuilder::new(app, name)
        .item(&MenuItemBuilder::with_id("app:hereState", l(state)).enabled(false).build(app)?)
        .item(&tauri::menu::CheckMenuItemBuilder::with_id(format!("server:{n}"), l("serverOpen")).checked(current).build(app)?)
        .separator();
    menu = if up {
        menu.item(&MenuItemBuilder::with_id("app:hereRestart", l("serverRestart")).build(app)?)
            .item(&MenuItemBuilder::with_id("app:hereStop1h", l("serverStop1h")).build(app)?)
            .item(&MenuItemBuilder::with_id("app:hereStop", l("serverStopHeld")).build(app)?)
    } else {
        menu.item(&MenuItemBuilder::with_id("app:hereStart", l("serverStartNow")).build(app)?)
    };
    menu.build()
}

/// The server here changed phase: the Mac's menu bar says so (rebuilt only when what it shows changed).
pub fn here_changed(app: &AppHandle) {
    static SHOWN: Mutex<Option<(&'static str, bool)>> = Mutex::new(None);
    let now = here_state(crate::local_server::phase(app));
    {
        let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
        if *shown == Some(now) {
            return;
        }
        *shown = Some(now);
    }
    let _ = rebuild(app);
}

/// The popover's labels for the menu bar (it knows the app's language); only the popover sets them.
#[tauri::command]
pub fn app_menu_set(app: AppHandle, window: tauri::Window, labels: HashMap<String, String>) -> Result<(), String> {
    if window.label() != "popover" {
        return Err("only the popover sets the menu".into());
    }
    if labels.len() > 100 || labels.iter().any(|(k, v)| k.len() > 40 || v.chars().count() > MAX_LABEL) {
        return Err("bad labels".into());
    }
    *app.state::<MenuParts>().labels.lock().unwrap_or_else(|e| e.into_inner()) = labels;
    crate::tray::refresh(&app);
    rebuild(&app)
}

/// The menu bar again, with the labels, servers and organizations it has now.
pub fn rebuild(app: &AppHandle) -> Result<(), String> {
    // Windows and Linux would show it inside every window, the popover too: the menu bar is the Mac's.
    #[cfg(target_os = "macos")]
    {
        let parts = app.state::<MenuParts>();
        let labels = parts.labels.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if labels.is_empty() {
            return Ok(()); // the popover hasn't sent them yet
        }
        let orgs = parts.orgs.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let menu = build_app_menu(app, &labels, &orgs).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

/// The site's organizations (`this_mac` `orgs`, already checked), for the Go menu; whether they changed.
pub fn set_orgs(app: &AppHandle, orgs: &serde_json::Value) -> bool {
    let list: Vec<(String, String)> = orgs
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|o| Some((o["id"].as_str()?.to_string(), o["name"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    {
        let parts = app.state::<MenuParts>();
        let mut orgs = parts.orgs.lock().unwrap_or_else(|e| e.into_inner());
        if *orgs == list {
            return false;
        }
        *orgs = list;
    }
    let _ = rebuild(app);
    true
}

/// A download finished (main_window.rs): a notification with its name, in the app's language.
pub fn downloaded(app: &AppHandle, name: &str) {
    use tauri_plugin_notification::NotificationExt;
    let title = app
        .state::<MenuParts>()
        .labels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("downloaded")
        .cloned()
        .unwrap_or_else(|| "Download".into());
    let _ = app.notification().builder().title(title).body(name).show();
}

/// One choice of the site's right-click menu.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContextItem {
    Item {
        id: String,
        label: String,
        #[serde(default)]
        disabled: bool,
    },
    Header {
        label: String,
    },
    Separator,
    Submenu {
        label: String,
        items: Vec<ContextItem>,
    },
}

const MAX_ITEMS: usize = 60;

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// The menu checked: few items, short labels, plain ids, one level of submenus.
fn check(items: &[ContextItem], depth: usize, count: &mut usize) -> Result<(), String> {
    for item in items {
        *count += 1;
        if *count > MAX_ITEMS {
            return Err("too many items".into());
        }
        match item {
            ContextItem::Item { id, label, .. } => {
                if !valid_id(id) || label.is_empty() || label.chars().count() > MAX_LABEL {
                    return Err("bad item".into());
                }
            }
            ContextItem::Header { label } => {
                if label.chars().count() > MAX_LABEL {
                    return Err("bad header".into());
                }
            }
            ContextItem::Separator => {}
            ContextItem::Submenu { label, items } => {
                if depth > 0 || label.is_empty() || label.chars().count() > MAX_LABEL {
                    return Err("bad submenu".into());
                }
                check(items, depth + 1, count)?;
            }
        }
    }
    Ok(())
}

fn add_items<'a>(
    app: &'a AppHandle,
    token: u32,
    items: &[ContextItem],
    mut builder: SubmenuBuilder<'a, tauri::Wry, AppHandle>,
) -> tauri::Result<SubmenuBuilder<'a, tauri::Wry, AppHandle>> {
    for item in items {
        builder = match item {
            ContextItem::Item { id, label, disabled } => {
                let b = MenuItemBuilder::with_id(format!("ctx:{token}:{id}"), label).enabled(!disabled);
                builder.item(&b.build(app)?)
            }
            ContextItem::Header { label } => builder.item(&MenuItemBuilder::new(label).enabled(false).build(app)?),
            ContextItem::Separator => builder.separator(),
            ContextItem::Submenu { label, items } => {
                let sub = add_items(app, token, items, SubmenuBuilder::new(app, label))?.build()?;
                builder.item(&sub)
            }
        };
    }
    Ok(builder)
}

/// The site's right-click menu in the system's look: drawn at the pointer; the choice goes back to the page.
#[tauri::command]
pub fn context_menu(app: AppHandle, webview: tauri::Webview, token: u32, items: Vec<ContextItem>) -> Result<(), String> {
    // The site itself, not the cover that shares its window.
    if webview.label() != main_window::LABEL {
        return Err("only the main window asks this".into());
    }
    check(&items, 0, &mut 0)?;
    let menu = add_items(&app, token, &items, SubmenuBuilder::new(&app, ""))
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?;
    webview.window().popup_menu(&menu).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_here_in_the_menu_bar() {
        use crate::local_server::Phase;
        // On its way or up: Restart and Stop; down or not starting: Start now.
        assert_eq!(here_state(Phase::Running), ("serverRunning", true));
        assert_eq!(here_state(Phase::Restarting), ("serverStarting", true));
        assert_eq!(here_state(Phase::Failing), ("serverFailing", false));
        assert_eq!(here_state(Phase::Stopped), ("serverStopped", false));
        assert_eq!(here_state(Phase::Off), ("serverStopped", false));
    }

    fn item(id: &str) -> ContextItem {
        ContextItem::Item { id: id.into(), label: "Copiar".into(), disabled: false }
    }

    #[test]
    fn context_menus_are_checked() {
        assert!(check(&[item("copy"), ContextItem::Separator, item("reply")], 0, &mut 0).is_ok());
        assert!(check(&[item("bad id!")], 0, &mut 0).is_err());
        assert!(check(&[item("")], 0, &mut 0).is_err());
        let deep = ContextItem::Submenu {
            label: "Reagir".into(),
            items: vec![ContextItem::Submenu { label: "x".into(), items: vec![item("a")] }],
        };
        assert!(check(&[deep], 0, &mut 0).is_err());
        let many: Vec<_> = (0..=MAX_ITEMS).map(|n| item(&format!("i{n}"))).collect();
        assert!(check(&many, 0, &mut 0).is_err());
    }

    #[test]
    fn calls_into_the_page_are_quoted() {
        assert_eq!(site_call("__agentesMenu", &["newMessage"]), r#"window.__agentesMenu?.("newMessage")"#);
        assert_eq!(
            site_call("__agentesContextMenu", &["7", "copy\");alert(1)//"]),
            r#"window.__agentesContextMenu?.("7","copy\");alert(1)//")"#
        );
    }

    #[test]
    fn zoom_steps() {
        let z = Zoom::default();
        assert_eq!(z.step(0), 1.0);
        assert_eq!(z.step(1), 1.1);
        assert_eq!(z.step(-1), 1.0);
        for _ in 0..20 {
            z.step(-1);
        }
        assert_eq!(z.step(0), 1.0);
    }
}
