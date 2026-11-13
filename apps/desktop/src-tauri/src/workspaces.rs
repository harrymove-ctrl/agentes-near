//! Workspaces across servers (ADR 0154): every server of the list, read with that server's own session (the
//! cookies the main window keeps for it, `sent_to`), the way the phone app asks (no `Origin`,
//! `X-Agentes-Client: mobile`): its workspaces (`GET /api/app/me`) and their unread counts (`GET /api/app/me/unread`),
//! every minute and when the window comes to the front. The site's workspace menu lists them by server
//! (`this_mac` `workspaces`), Preferences › Servers shows them under each server, and a server not open in the window
//! that has new unread notifications says so with the system's notification, named after the workspace and server.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::{main_window, servers};

/// How often every server is asked.
const EVERY: Duration = Duration::from_secs(60);
/// The window coming to the front asks again, at most this often.
const FOCUS_GAP: Duration = Duration::from_secs(15);
/// The site's menu asks for a fresh list when the last one is older than this.
const STALE: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);
/// Workspaces kept per server.
const MAX_ORGS: usize = 50;
/// A workspace's logo, as a data URL (larger ones show the workspace's mark instead).
const LOGO_MAX: u64 = 256 * 1024;
/// A JSON answer's size.
const BODY_MAX: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Org {
    pub id: String,
    pub name: String,
    /// A data URL; None shows the workspace's mark.
    pub logo: Option<String>,
    pub unread: u64,
    pub waiting: u64,
    /// The person may pair a computer with it (`pair_computers`): Preferences and the sign-in's card offer this one.
    pub pair: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWorkspaces {
    pub server: String,
    /// Its session in the window's cookies still answers; false lists no workspace (sign in there again).
    pub signed_in: bool,
    pub orgs: Vec<Org>,
    /// It didn't answer (offline, an error) since this time (Unix milliseconds): what it said last stays, marked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_since: Option<u64>,
    /// The server the app runs on this computer (at its local or its Tailscale address): named as such, never by it.
    pub here: bool,
    /// Agents of its workspaces may work on this computer (`main_window::agents_here`, and no server here answers as it).
    pub agents_here: bool,
}

#[derive(Default)]
pub struct Workspaces(Mutex<State>);

#[derive(Default)]
struct State {
    /// The last answer of each server, in the list's order.
    list: Vec<ServerWorkspaces>,
    /// Logos already read, by their address (None: none to show).
    logos: HashMap<String, Option<String>>,
    checked: Option<Instant>,
    asked_on_focus: Option<Instant>,
    wake: Option<mpsc::Sender<()>>,
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, State> {
    app.state::<Workspaces>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

/// The workspaces of every server, as last read (the site's own server included).
pub fn list(app: &AppHandle) -> Vec<ServerWorkspaces> {
    lock(app).list.clone()
}

/// The last list is older than `STALE` (or there's none yet).
pub fn stale(app: &AppHandle) -> bool {
    lock(app).checked.map_or(true, |at| at.elapsed() > STALE)
}

/// No server read yet: the loop's first pass ran before the main window existed (there were no cookies to read).
pub fn never_read(app: &AppHandle) -> bool {
    lock(app).checked.is_none()
}

/// Every server read now, on the caller's thread (never a command's or an event handler's: Windows deadlocks).
pub fn refresh_now(app: &AppHandle) {
    refresh(app);
}

/// Asks every server again now (the loop does it on its own thread).
pub fn trigger(app: &AppHandle) {
    if let Some(wake) = lock(app).wake.as_ref() {
        let _ = wake.send(());
    }
}

/// The window came to the front: the servers are asked again, at most every 15 seconds.
pub fn on_focus(app: &AppHandle) {
    {
        let mut state = lock(app);
        if state.asked_on_focus.is_some_and(|at| at.elapsed() < FOCUS_GAP) {
            return;
        }
        state.asked_on_focus = Some(Instant::now());
    }
    trigger(app);
}

/// The windows hear that the list changed (the popover offers this computer to a workspace it doesn't work for yet).
pub const CHANGED_EVENT: &str = "workspaces://changed";

/// The loop: every minute, or when woken. Reading cookies needs a thread of its own (it waits for the web view,
/// and deadlocks on Windows from a command or an event handler).
pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    lock(app).wake = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || loop {
        refresh(&app);
        match rx.recv_timeout(EVERY) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {
                // Several wakes at once ask once.
                while rx.try_recv().is_ok() {}
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    });
}

/// Every server of the list asked once; new unread notifications on a server not open in the window are told.
fn refresh(app: &AppHandle) {
    // The cookies are the main window's: before it was ever opened (started at login) there is nothing to read.
    let Some(page) = app.get_webview(main_window::LABEL) else { return };
    let open = page.url().ok().map(|u| u.origin().ascii_serialization());
    let file = servers::get(app);
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
    let home = app.path().home_dir().ok();
    let mut logos = lock(app).logos.clone();
    let before = list(app);
    let mut next = Vec::with_capacity(file.servers.len());
    for server in &file.servers {
        let Ok(url) = server.parse::<Url>() else { continue };
        let cookies: Vec<_> = page.cookies().unwrap_or_default().into_iter().filter(|c| sent_to(c, &url)).collect();
        let cookie = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
        let here = crate::local_server::is_here(app, server);
        let agents_here = main_window::agents_here(server, here)
            && home.as_ref().is_some_and(|h| !crate::discover::served_here(h, server));
        match ask(&agent, server, &cookie, &mut logos) {
            Some(answer) => next.push(ServerWorkspaces { here, agents_here, ..answer }),
            // Not reached (offline, an error): what it said last stays, marked since when.
            None => {
                if let Some(old) = before.iter().find(|s| &s.server == server) {
                    next.push(ServerWorkspaces { here, agents_here, ..unreachable(old, now_ms()) });
                }
            }
        }
    }
    let changed = next != before;
    let told = news(&before, &next, open.as_deref());
    {
        let mut state = lock(app);
        state.list = next;
        state.logos = logos;
        state.checked = Some(Instant::now());
    }
    for (server, org, count) in told {
        tell(app, &server, &org, count);
    }
    if changed {
        let _ = app.emit(CHANGED_EVENT, ());
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A server that didn't answer: its last answer, offline since the first time it didn't.
pub fn unreachable(last: &ServerWorkspaces, now: u64) -> ServerWorkspaces {
    ServerWorkspaces { offline_since: last.offline_since.or(Some(now)), ..last.clone() }
}

/// One server: signed out (no session, or it refused it) lists nothing; None when it couldn't be reached.
fn ask(agent: &ureq::Agent, server: &str, cookie: &str, logos: &mut HashMap<String, Option<String>>) -> Option<ServerWorkspaces> {
    let signed_out = ServerWorkspaces { server: server.to_string(), signed_in: false, ..Default::default() };
    if cookie.is_empty() {
        return Some(signed_out);
    }
    let me = match get_json(agent, &format!("{server}/api/app/me"), cookie) {
        Ok(Some(me)) => me,
        Ok(None) => return Some(signed_out),
        Err(()) => return None,
    };
    // A server from before ADR 0154 has no `/me/unread`: its workspaces show without counts.
    let unread = get_json(agent, &format!("{server}/api/app/me/unread"), cookie).ok().flatten();
    let counts = unread.as_ref().map(parse_unread).unwrap_or_default();
    let orgs = parse_me(&me)
        .into_iter()
        .map(|(id, name, logo, pair)| {
            let (unread, waiting) = counts.get(&id).copied().unwrap_or((0, 0));
            let logo = logo.and_then(|path| logo_data(agent, server, &path, cookie, logos));
            Org { id, name, logo, unread, waiting, pair }
        })
        .collect();
    Some(ServerWorkspaces { server: server.to_string(), signed_in: true, orgs, ..Default::default() })
}

/// Who the main window is signed in as on `server` (the account's id), read with its cookies there as the minute's
/// check does; None when signed out there or it didn't answer. Not from a command or an event handler (Windows).
pub fn window_user(app: &AppHandle, server: &str) -> Option<String> {
    let page = app.get_webview(main_window::LABEL)?;
    let url = server.parse::<Url>().ok()?;
    let cookies: Vec<_> = page.cookies().ok()?.into_iter().filter(|c| sent_to(c, &url)).collect();
    let cookie = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
    if cookie.is_empty() {
        return None;
    }
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
    let me = get_json(&agent, &format!("{server}/api/app/me"), &cookie).ok()??;
    me.pointer("/user/id").and_then(Value::as_str).map(str::to_string)
}

/// The answer as JSON; Ok(None) when the session isn't (any longer) signed in there.
fn get_json(agent: &ureq::Agent, url: &str, cookie: &str) -> Result<Option<Value>, ()> {
    match agent.get(url).set("Cookie", cookie).set("X-Agentes-Client", "mobile").set("Accept", "application/json").call() {
        Ok(response) => {
            let mut text = String::new();
            response.into_reader().take(BODY_MAX).read_to_string(&mut text).map_err(|_| ())?;
            serde_json::from_str(&text).map(Some).map_err(|_| ())
        }
        Err(ureq::Error::Status(401 | 403, _)) => Ok(None),
        Err(_) => Err(()),
    }
}

/// A workspace's logo from its own server, as a data URL, read once per address.
fn logo_data(
    agent: &ureq::Agent,
    server: &str,
    path: &str,
    cookie: &str,
    logos: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let base: Url = server.parse().ok()?;
    let url = base.join(path).ok()?;
    // Only from that server: a logo address never sends its cookies anywhere else.
    if url.origin() != base.origin() {
        return None;
    }
    if let Some(known) = logos.get(url.as_str()) {
        return known.clone();
    }
    let read = || -> Option<String> {
        let response = agent.get(url.as_str()).set("Cookie", cookie).set("X-Agentes-Client", "mobile").call().ok()?;
        let kind = response.content_type().to_string();
        if !kind.starts_with("image/") || kind.contains(';') || kind.contains('"') {
            return None;
        }
        let mut bytes = Vec::new();
        response.into_reader().take(LOGO_MAX + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > LOGO_MAX {
            return None;
        }
        Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    };
    let logo = read();
    logos.insert(url.to_string(), logo.clone());
    logo
}

/// Whether the window's cookie goes with a request to `url`. Not wry's `cookies_for_url`: it compares the cookie's
/// domain with `Url::domain`, which is None for an IP address, so the server on this computer
/// (`http://127.0.0.1:4310`) got no cookie, read as signed out and left the site's workspace menu.
pub fn sent_to<C: CookieLike>(cookie: &C, url: &Url) -> bool {
    cookie_for(cookie.domain_of(), cookie.secure_of(), cookie.path_of(), url)
}

/// The cookie crate's `Cookie`, as `sent_to` reads it (a trait so the rule is tested without a web view).
pub trait CookieLike {
    fn domain_of(&self) -> Option<&str>;
    fn secure_of(&self) -> bool;
    fn path_of(&self) -> Option<&str>;
}

impl CookieLike for tauri::webview::Cookie<'_> {
    fn domain_of(&self) -> Option<&str> {
        self.domain()
    }
    fn secure_of(&self) -> bool {
        self.secure().unwrap_or(false)
    }
    fn path_of(&self) -> Option<&str> {
        self.path()
    }
}

/// The browser's rule, enough for our servers: the same host (an IP address too) or a parent domain the cookie names
/// (".example.com"), a path the request's starts with, and a secure cookie only over https or on this computer.
pub fn cookie_for(domain: Option<&str>, secure: bool, path: Option<&str>, url: &Url) -> bool {
    let (Some(host), Some(domain)) = (url.host_str(), domain) else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    let host_ok = host == domain || (url.domain().is_some() && host.ends_with(&format!(".{domain}")));
    let here = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let secure_ok = !secure || url.scheme() == "https" || here;
    let path_ok = path.is_none_or(|p| p.is_empty() || url.path().starts_with(p));
    host_ok && secure_ok && path_ok
}

/// The `Cookie` header for a server from the window's cookies for it.
pub fn cookie_header<'a>(cookies: impl Iterator<Item = (&'a str, &'a str)>) -> String {
    cookies
        .filter(|(name, value)| !name.is_empty() && !format!("{name}{value}").chars().any(|c| c.is_control() || c == ';'))
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// An id the app passes on (`orgId` in main_window.rs): letters, digits, `-` and `_`.
pub(crate) fn good_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The workspaces of `GET /api/app/me`: id, name, logo address and whether the person may pair a computer with it,
/// those still being set up left out.
pub fn parse_me(me: &Value) -> Vec<(String, String, Option<String>, bool)> {
    let Some(orgs) = me.get("organizations").and_then(Value::as_array) else { return vec![] };
    orgs.iter()
        .filter(|o| o.get("onboarding").map_or(true, Value::is_null))
        .filter_map(|o| {
            let id = o.get("id")?.as_str()?;
            let name: String = o.get("name")?.as_str()?.trim().chars().take(80).collect();
            if !good_id(id) || name.is_empty() || name.chars().any(char::is_control) {
                return None;
            }
            let logo = o.get("logo").and_then(Value::as_str).filter(|l| l.len() <= 1024).map(str::to_string);
            let pair = o
                .get("permissions")
                .and_then(Value::as_array)
                .is_some_and(|keys| keys.iter().any(|k| k == "pair_computers"));
            Some((id.to_string(), name, logo, pair))
        })
        .take(MAX_ORGS)
        .collect()
}

/// `GET /api/app/me/unread`: unread and waiting by workspace.
pub fn parse_unread(body: &Value) -> HashMap<String, (u64, u64)> {
    body.get("organizations")
        .and_then(Value::as_array)
        .map(|orgs| {
            orgs.iter()
                .filter_map(|o| {
                    let id = o.get("orgId")?.as_str()?;
                    let count = |key: &str| o.get(key).and_then(Value::as_u64).unwrap_or(0).min(100_000);
                    good_id(id).then(|| (id.to_string(), (count("unread"), count("waiting"))))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What's new since the last check, to tell: on a server other than the one open in the window (`open`; with no
/// page, none is told), each workspace whose unread count grew, with how many more. A workspace or server seen for
/// the first time tells nothing (its count isn't news).
pub fn news(before: &[ServerWorkspaces], after: &[ServerWorkspaces], open: Option<&str>) -> Vec<(String, Org, u64)> {
    let Some(open) = open else { return vec![] };
    let mut told = Vec::new();
    for now in after.iter().filter(|s| s.server != open && s.signed_in) {
        let Some(then) = before.iter().find(|s| s.server == now.server && s.signed_in) else { continue };
        for org in &now.orgs {
            if let Some(old) = then.orgs.iter().find(|o| o.id == org.id) {
                if org.unread > old.unread {
                    told.push((now.server.clone(), org.clone(), org.unread - old.unread));
                }
            }
        }
    }
    told
}

/// How a server is named to people: agentes.chat for the Cloud, the app's own server by what it is (never its
/// local or Tailscale address), its host otherwise.
pub fn server_name(server: &str, cloud_name: &str, here_name: Option<&str>) -> String {
    if server == servers::CLOUD {
        return cloud_name.to_string();
    }
    if let Some(name) = here_name {
        return name.to_string();
    }
    // Host and port, as the site names it (`serverHost`): two servers on one computer stay apart.
    let named = |u: Url| u.host_str().map(|h| u.port().map_or_else(|| h.to_string(), |p| format!("{h}:{p}")));
    server.parse::<Url>().ok().and_then(named).unwrap_or_else(|| server.to_string())
}

/// The notification's words: "Workspace · server" and "1 new notification" / "3 new notifications" (the
/// popover's labels, in the app's language; nothing is told before they arrived). `here`: the app's own server.
pub fn notice_text(
    labels: &HashMap<String, String>,
    server: &str,
    here: bool,
    org: &str,
    count: u64,
) -> Option<(String, String)> {
    let cloud = labels.get("serversCloud")?;
    let body = if count == 1 { labels.get("workspaceNewsOne")? } else { labels.get("workspaceNewsMany")? };
    let here_name = if here { Some(labels.get("serverTitle")?.as_str()) } else { None };
    let title: String = format!("{org} · {}", server_name(server, cloud, here_name)).chars().take(80).collect();
    Some((title, body.replace("{count}", &count.to_string())))
}

fn tell(app: &AppHandle, server: &str, org: &Org, count: u64) {
    let labels = crate::menus::labels(app);
    let here = crate::local_server::is_here(app, server);
    let Some((title, body)) = notice_text(&labels, server, here, &org.name, count) else { return };
    let Ok(url) = format!("{server}/org/{}/notifications", org.id).parse::<Url>() else { return };
    main_window::notice(app, &title, &body, url);
}

/// Preferences › Servers: every server's workspaces (the app's own windows only).
#[tauri::command]
pub fn workspaces_get(app: AppHandle, window: tauri::Window) -> Result<Vec<ServerWorkspaces>, String> {
    if !matches!(window.label(), "prefs" | "popover") {
        return Err("only the app's own windows ask this".into());
    }
    if stale(&app) {
        trigger(&app);
    }
    Ok(list(&app))
}

/// What the app's own windows may ask a server with its session (`site_fetch`): this computer's devices and who can
/// use them, a phone's Stop, the workspace's people and roles for the rule's picker, and confirming the code of this
/// computer's own runner (the person allowed it in the app's card or the system's dialog). Nothing else.
pub fn site_path_allowed(method: &str, path: &str) -> bool {
    if path.len() > 512 || path.contains(['?', '#', '%', '\\']) {
        return false;
    }
    // Whether the person has a password (Preferences' "Add a password" note on the server here).
    if method == "GET" && path == "/api/app/me" {
        return true;
    }
    let parts: Vec<&str> = path.split('/').collect();
    let ["", "api", "app", "organizations", org, rest @ ..] = parts.as_slice() else { return false };
    good_id(org)
        && match (method, rest) {
            ("GET", ["devices" | "members" | "roles"]) => true,
            ("PATCH", ["devices", "computers" | "phones", id]) => good_id(id),
            ("POST", ["devices", "phones", id, "stop"]) => good_id(id),
            ("POST", ["machines", "device", code, "confirm"]) => {
                (4..=16).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric())
            }
            _ => false,
        }
}

/// A request body's size (a device's rule with its people).
const SITE_BODY_MAX: usize = 64 * 1024;

#[derive(Debug, Serialize)]
pub struct SiteAnswer {
    pub status: u16,
    pub body: String,
}

/// One request to `server` (a server of the app's list) with the main window's session for it, the way the phone
/// app asks. Blocking: reading the cookies waits for the web view, so never from a command's or an event's own thread.
pub fn with_session(
    app: &AppHandle,
    server: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<SiteAnswer, String> {
    if !servers::get(app).servers.iter().any(|s| s == server) {
        return Err("not a server of this app".into());
    }
    if !site_path_allowed(method, path) || body.is_some_and(|b| b.len() > SITE_BODY_MAX) {
        return Err("not allowed".into());
    }
    let url: Url = format!("{server}{path}").parse().map_err(|_| "bad address")?;
    let page = app.get_webview(main_window::LABEL).ok_or("signed_out")?;
    let cookies = page.cookies_for_url(url.clone()).unwrap_or_default();
    let cookie = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
    if cookie.is_empty() {
        return Err("signed_out".into());
    }
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
    let request = agent
        .request(method, url.as_str())
        .set("Cookie", &cookie)
        .set("X-Agentes-Client", "mobile")
        .set("Accept", "application/json");
    let sent = match body {
        Some(body) => request.set("Content-Type", "application/json").send_string(body),
        None => request.call(),
    };
    let response = match sent {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(e) => return Err(e.to_string()),
    };
    let status = response.status();
    let mut text = String::new();
    response.into_reader().take(BODY_MAX).read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(SiteAnswer { status, body: text })
}

/// Preferences › This Mac and the welcome window's pairing card read and set this computer's devices on its server
/// (`with_session`).
#[tauri::command]
pub async fn site_fetch(
    app: AppHandle,
    window: tauri::Window,
    server: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<SiteAnswer, String> {
    if !matches!(window.label(), "prefs" | "welcome") {
        return Err("only Preferences and the welcome window ask this".into());
    }
    tauri::async_runtime::spawn_blocking(move || with_session(&app, &server, &method, &path, body.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// How the welcome window opens next, taken once: `add` when the site's "Add a workspace" opened it.
#[derive(Default)]
pub struct WelcomeMode(pub Mutex<Option<&'static str>>);

#[tauri::command]
pub fn welcome_mode_take(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window asks this".into());
    }
    Ok(app.state::<WelcomeMode>().0.lock().unwrap_or_else(|e| e.into_inner()).take().map(str::to_string))
}

/// "Add a workspace…" and "Add a server…" in Preferences: the welcome window, in its adding mode.
/// Async, as `show_window`: the welcome window may be made here.
#[tauri::command]
pub async fn welcome_add(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != "prefs" {
        return Err("only Preferences asks this".into());
    }
    *app.state::<WelcomeMode>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some("add");
    crate::present(&app, "welcome")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn org(id: &str, unread: u64) -> Org {
        Org { id: id.into(), name: id.to_uppercase(), logo: None, unread, waiting: 0, pair: false }
    }
    fn server(s: &str, signed_in: bool, orgs: Vec<Org>) -> ServerWorkspaces {
        ServerWorkspaces { server: s.into(), signed_in, orgs, ..Default::default() }
    }

    #[test]
    fn the_window_cookies_a_server_gets() {
        let url = |u: &str| u.parse::<Url>().unwrap();
        // The server on this computer, by its IP address: wry's own lookup gave it none.
        assert!(cookie_for(Some("127.0.0.1"), false, Some("/"), &url("http://127.0.0.1:4310")));
        assert!(cookie_for(Some("localhost"), true, Some("/"), &url("http://localhost:3000")));
        assert!(cookie_for(Some(".exemplo.com.br"), true, Some("/"), &url("https://agentes.exemplo.com.br")));
        assert!(cookie_for(Some("agentes.exemplo.com.br"), true, None, &url("https://agentes.exemplo.com.br/x")));
        // Another host, a secure cookie over plain http elsewhere, another path: not sent.
        assert!(!cookie_for(Some("agentes-1.tail1234.ts.net"), true, Some("/"), &url("https://agentes.tail1234.ts.net")));
        assert!(!cookie_for(Some("chat.example.com"), true, Some("/"), &url("http://chat.example.com")));
        assert!(!cookie_for(Some("127.0.0.1"), false, Some("/api/auth"), &url("http://127.0.0.1:4310/")));
        assert!(!cookie_for(None, false, Some("/"), &url("http://127.0.0.1:4310")));
        // An IP address never takes a parent domain's cookie.
        assert!(!cookie_for(Some("0.0.1"), false, Some("/"), &url("http://127.0.0.1:4310")));
    }

    #[test]
    fn a_server_that_stopped_answering() {
        let last = server("https://agentes.exemplo.com.br", true, vec![]);
        let first = unreachable(&last, 1_000);
        assert_eq!(first.offline_since, Some(1_000));
        assert!(first.signed_in, "its last answer stays");
        // Still not answering a minute later: offline since the first time.
        assert_eq!(unreachable(&first, 61_000).offline_since, Some(1_000));
    }

    #[test]
    fn workspaces_from_me() {
        let me = json!({ "organizations": [
            { "id": "o-1", "name": "  Acme ", "logo": "/api/app/org-logos/o-1/a.png", "permissions": ["post", "pair_computers"] },
            { "id": "o-2", "name": "Norte", "logo": null, "permissions": ["post"] },
            { "id": "o-3", "name": "Setting up", "onboarding": { "step": 1 } },
            { "id": "../x", "name": "Bad" },
            { "id": "o-4", "name": "" },
        ]});
        assert_eq!(
            parse_me(&me),
            vec![
                ("o-1".into(), "Acme".into(), Some("/api/app/org-logos/o-1/a.png".into()), true),
                ("o-2".into(), "Norte".into(), None, false),
            ]
        );
        assert!(parse_me(&json!({})).is_empty());
    }

    #[test]
    fn counts_from_me_unread() {
        let counts = parse_unread(&json!({ "organizations": [
            { "orgId": "o-1", "unread": 3, "waiting": 1 },
            { "orgId": "../x", "unread": 9 },
            { "orgId": "o-2" },
        ]}));
        assert_eq!(counts.get("o-1"), Some(&(3, 1)));
        assert_eq!(counts.get("o-2"), Some(&(0, 0)));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn only_the_devices_paths_go_with_the_session() {
        let org = "/api/app/organizations/o-1";
        assert!(site_path_allowed("GET", &format!("{org}/devices")));
        assert!(site_path_allowed("GET", "/api/app/me"));
        assert!(!site_path_allowed("PATCH", "/api/app/me"));
        assert!(site_path_allowed("GET", &format!("{org}/members")));
        assert!(site_path_allowed("GET", &format!("{org}/roles")));
        assert!(site_path_allowed("PATCH", &format!("{org}/devices/computers/m-1")));
        assert!(site_path_allowed("PATCH", &format!("{org}/devices/phones/p-1")));
        assert!(site_path_allowed("POST", &format!("{org}/devices/phones/p-1/stop")));
        assert!(site_path_allowed("POST", &format!("{org}/machines/device/K7Q4ZP/confirm")));
        for (method, path) in [
            ("POST", format!("{org}/machines/device/K7Q-4ZP/confirm")),
            ("POST", format!("{org}/machines/device/K7Q4ZP/deny")),
            ("GET", format!("{org}/machines/device/K7Q4ZP/confirm")),
            ("DELETE", format!("{org}/devices/computers/m-1")),
            ("POST", format!("{org}/devices/connect-links")),
            ("GET", format!("{org}/devices?x=1")),
            ("GET", format!("{org}/devices/")),
            ("PATCH", format!("{org}/devices/phones/../stop")),
            ("GET", "/api/app/organizations/../x/devices".into()),
            ("GET", format!("{org}/channels")),
            ("POST", format!("{org}/devices/phones/p%2F1/stop")),
        ] {
            assert!(!site_path_allowed(method, &path), "{method} {path}");
        }
    }

    #[test]
    fn the_cookie_header() {
        let header = cookie_header(
            [("__Secure-better-auth.session_token", "abc.def"), ("x", "a;b"), ("", "v"), ("theme", "dark")].into_iter(),
        );
        assert_eq!(header, "__Secure-better-auth.session_token=abc.def; theme=dark");
    }

    #[test]
    fn only_new_unread_elsewhere_is_told() {
        let open = "https://app.agentes.chat";
        let own = "https://agentes.exemplo.com.br";
        let before = vec![server(open, true, vec![org("a", 1)]), server(own, true, vec![org("b", 2), org("c", 5)])];
        let after = vec![
            server(open, true, vec![org("a", 9)]),
            server(own, true, vec![org("b", 4), org("c", 3), org("d", 7)]),
        ];
        let told = news(&before, &after, Some(open));
        assert_eq!(told.len(), 1, "the server open isn't told, nor fewer unread, nor a workspace seen first now");
        assert_eq!((told[0].0.as_str(), told[0].1.id.as_str(), told[0].2), (own, "b", 2));
        assert!(news(&before, &after, None).is_empty(), "no page: nothing told");
        // Signed in again just now: its counts aren't news.
        let signed_out = vec![server(own, false, vec![])];
        assert!(news(&signed_out, &after, Some(open)).is_empty());
    }

    #[test]
    fn notice_words() {
        let labels: HashMap<String, String> = [
            ("serversCloud", "agentes.chat"),
            ("serverTitle", "O agentes.chat neste Mac"),
            ("workspaceNewsOne", "1 notificação nova"),
            ("workspaceNewsMany", "{count} notificações novas"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(
            notice_text(&labels, "https://agentes.exemplo.com.br", false, "Oficina", 3),
            Some(("Oficina · agentes.exemplo.com.br".into(), "3 notificações novas".into()))
        );
        assert_eq!(
            notice_text(&labels, servers::CLOUD, false, "Acme", 1),
            Some(("Acme · agentes.chat".into(), "1 notificação nova".into()))
        );
        // The app's own server by what it is, at its local or its Tailscale address alike.
        assert_eq!(
            notice_text(&labels, "https://macbook-air.tail1234.ts.net", true, "Oficina", 1),
            Some(("Oficina · O agentes.chat neste Mac".into(), "1 notificação nova".into()))
        );
        assert_eq!(notice_text(&HashMap::new(), servers::CLOUD, false, "Acme", 1), None, "before the labels arrived");
    }
}
