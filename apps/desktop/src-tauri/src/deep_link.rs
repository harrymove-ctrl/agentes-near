//! `agenteschat://` links (the setup's end, a QR code's link, a teammate's): the welcome window shows them,
//! with the server in large type, and nothing changes before the person confirms there. Rust keeps only the
//! newest link until the window takes it (`link_take`), and passes nothing it didn't check is one of ours.
//! A connector's sign-in that the browser hands back (`agenteschat://desktop/connectors/oauth`) goes to the
//! main window instead, which finishes it with its own session.
//! A pair link (`agenteschat://pair?server=&link=`, the web's "Open the agentes.chat app") goes there too, rebuilt from
//! its two checked fields: the window asks the server who made the link (`pair_link_info`) and pairs this computer
//! only after the person confirms there, and then the link's maker still lets it in on the web (ADR 0066 §3 as amended).
//! On macOS a link reaches the running app as an event; on Windows and Linux as a second launch, which the
//! single-instance plugin hands to the deep-link plugin.

use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

pub const SCHEME: &str = "agenteschat";
/// A connect link is short (a server and a token or a claim); anything longer isn't one.
const MAX_LINK: usize = 2048;
/// A connect link's code: 8 of these, shown as `ABCD-EFGH` (packages/engine machine-device.ts `USER_CODE_ALPHABET`).
const CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INFO_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct PendingLink(Mutex<Option<String>>);

/// One of ours, of a size a link can be.
pub fn accept(url: &Url) -> bool {
    url.scheme() == SCHEME && url.as_str().len() <= MAX_LINK
}

/// A connector's sign-in that the browser handed back (apps/server connectors.ts `oauth/callback`).
fn is_connector_return(url: &Url) -> bool {
    url.host_str() == Some("desktop") && url.path() == "/connectors/oauth"
}

/// The page of `site` that finishes it (apps/web desktop.connector.tsx), with only its own fields.
pub fn connector_page(url: &Url, site: &Url) -> Option<Url> {
    if !is_connector_return(url) {
        return None;
    }
    let mut page = site.join("/desktop/connector").ok()?;
    page.set_fragment(None);
    page.set_query(None);
    let fields: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| matches!(&**key, "org" | "state" | "code" | "error"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    page.query_pairs_mut().extend_pairs(fields);
    Some(page)
}

/// A pair link's two fields: the server's origin and the code as the server stores it (`ABCDEFGH`).
#[derive(Debug, PartialEq)]
pub struct PairLink {
    pub server: String,
    pub code: String,
}

/// `ABCD-EFGH` or `abcdefgh` → `ABCDEFGH`; None for anything else.
fn link_code(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let bare = match raw.len() {
        8 => raw.to_string(),
        9 if raw.as_bytes()[4] == b'-' => raw.replacen('-', "", 1),
        _ => return None,
    }
    .to_ascii_uppercase();
    (bare.len() == 8 && bare.chars().all(|c| CODE_ALPHABET.contains(c))).then_some(bare)
}

/// `agenteschat://pair?server=<origin>&link=<code>`: a server the app may open (https, or http on loopback) and a
/// connect link's code. Other fields are ignored; None when it isn't one.
pub fn pair_link(url: &Url) -> Option<PairLink> {
    if url.scheme() != SCHEME || url.host_str() != Some("pair") || !matches!(url.path(), "" | "/") {
        return None;
    }
    let field = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let server = crate::servers::origin_of(field("server")?.trim())?;
    let code = link_code(&field("link")?)?;
    Some(PairLink { server, code })
}

/// The link the welcome window takes: only its checked fields.
fn pair_url(pair: &PairLink) -> String {
    let mut url = Url::parse("agenteschat://pair").expect("a fixed URL");
    url.query_pairs_mut().append_pair("server", &pair.server).append_pair("link", &pair.code);
    url.to_string()
}

fn receive(app: &AppHandle, urls: Vec<Url>) {
    let Some(url) = urls.into_iter().find(accept) else { return };
    // On the server open now, where the window is signed in: its state is that person's there.
    if is_connector_return(&url) {
        if let Some(page) = crate::main_window::site(app).and_then(|site| connector_page(&url, &site)) {
            let app = app.clone();
            // Not from inside the link's event: the window may have to be made first.
            std::thread::spawn(move || {
                let _ = crate::main_window::show_url(&app, page);
            });
        }
        return;
    }
    let pending = if url.host_str() == Some("pair") {
        // ponytail: a server on this computer is left out by its address only; one reached here at another address
        // (`discover::served_here`) would pair a second time, after its maker lets it in.
        match pair_link(&url) {
            Some(pair)
                if crate::main_window::agents_here(&pair.server, crate::local_server::is_here(app, &pair.server)) =>
            {
                pair_url(&pair)
            }
            _ => return,
        }
    } else {
        url.to_string()
    };
    *app.state::<PendingLink>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(pending);
    let _ = crate::present(app, "welcome");
    let _ = app.emit_to("welcome", "link://pending", ());
}

/// Listens for links, takes the one the app was opened with, and (Linux, where an AppImage has no
/// `.desktop` file of its own) registers the scheme.
pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| receive(&handle, event.urls()));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        receive(app, urls);
    }
    #[cfg(target_os = "linux")]
    let _ = app.deep_link().register_all();
}

/// A second launch carrying a link (Windows, Linux): the link is handled, the main window stays as it is.
pub fn in_args(args: &[String]) -> bool {
    args.iter().any(|a| a.starts_with("agenteschat:"))
}

#[tauri::command]
pub fn link_take(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window takes links".into());
    }
    Ok(app.state::<PendingLink>().0.lock().unwrap_or_else(|e| e.into_inner()).take())
}

/// What the server says about a live connect link (`GET /api/machines/connect-links/{code}`, no session).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub org: String,
    pub by: String,
    pub kind: String,
    pub expires_at: String,
    /// This computer's own name, for "This Mac: …"; None when the system doesn't say.
    pub computer: Option<String>,
}

/// A name from the server, shown as is: trimmed, at most 80 characters, no control characters.
fn shown_name(value: &Value) -> Option<String> {
    let name: String = value.as_str()?.trim().chars().take(80).collect();
    (!name.is_empty() && !name.chars().any(char::is_control)).then_some(name)
}

/// The server's answer: the link's workspace and maker, or `link_expired` (unknown, used or expired: one answer).
pub fn read_link_info(status: u16, body: &str) -> Result<LinkInfo, String> {
    if status == 404 {
        return Err("link_expired".into());
    }
    if status != 200 {
        return Err("unreachable".into());
    }
    let v: Value = serde_json::from_str(body).map_err(|_| "unreachable")?;
    let kind = v["kind"].as_str().filter(|k| matches!(*k, "computer" | "server")).ok_or("unreachable")?;
    Ok(LinkInfo {
        org: shown_name(&v["org"]["name"]).ok_or("unreachable")?,
        by: shown_name(&v["by"]["name"]).ok_or("unreachable")?,
        kind: kind.to_string(),
        expires_at: v["expiresAt"].as_str().filter(|t| t.len() <= 40).unwrap_or_default().to_string(),
        computer: None,
    })
}

/// This computer's name as people see it: the Mac's own, else the system's host name.
fn computer_name() -> Option<String> {
    crate::host_sync::computer_name()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && n.chars().count() <= 64)
}

/// The welcome window's pair link: who made it and for which workspace, asked of its server over plain HTTPS
/// (no cookies: the link is the only thing it knows). `link_expired`, or `unreachable`.
#[tauri::command]
pub async fn pair_link_info(window: tauri::Window, server: String, code: String) -> Result<LinkInfo, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window asks this".into());
    }
    let pair = Url::parse(&pair_url(&PairLink { server, code })).ok().and_then(|u| pair_link(&u)).ok_or("bad link")?;
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(INFO_TIMEOUT).redirects(0).build();
        let url = format!("{}/api/machines/connect-links/{}", pair.server, pair.code);
        let response = match agent.get(&url).set("Accept", "application/json").call() {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r,
            Err(_) => return Err("unreachable".to_string()),
        };
        let status = response.status();
        let mut body = String::new();
        let _ = response.into_reader().take(64 * 1024).read_to_string(&mut body);
        read_link_info(status, &body).map(|info| LinkInfo { computer: computer_name(), ..info })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_links() {
        let ok: Url = "agenteschat://connect?server=https%3A%2F%2Fagentes.tail1234.ts.net".parse().unwrap();
        assert!(accept(&ok));
        assert!(!accept(&"https://app.agentes.chat/connect".parse().unwrap()));
        let long: Url = format!("agenteschat://connect?server=x&pad={}", "a".repeat(MAX_LINK)).parse().unwrap();
        assert!(!accept(&long));
        assert!(in_args(&["/usr/bin/agentes".into(), "agenteschat://connect?server=x".into()]));
        assert!(!in_args(&["/usr/bin/agentes".into(), "--autostart".into()]));
    }

    #[test]
    fn pair_links() {
        let pair = |u: &str| pair_link(&u.parse().unwrap());
        let ok = Some(PairLink { server: "https://app.agentes.chat".into(), code: "ABCDEFGH".into() });
        assert_eq!(pair("agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGH"), ok);
        assert_eq!(pair("agenteschat://pair/?link=abcdefgh&server=https://app.agentes.chat/&utm=x"), ok);
        assert_eq!(
            pair("agenteschat://pair?server=http%3A%2F%2F127.0.0.1%3A4310&link=ABCD-EFGH").map(|p| p.server),
            Some("http://127.0.0.1:4310".into())
        );
        for bad in [
            "agenteschat://pair?server=http%3A%2F%2Fagentes.example.com&link=ABCD-EFGH",
            "agenteschat://pair?server=https%3A%2F%2Fu%3Ap%40agentes.example.com&link=ABCD-EFGH",
            "agenteschat://pair?server=agentes.example.com&link=ABCD-EFGH",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFG",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGHJ",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABC-DEFGH",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFG1",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-ÉFGH",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat",
            "agenteschat://pair?link=ABCD-EFGH",
            "agenteschat://pair/x?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGH",
            "agenteschat://connect?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGH",
        ] {
            assert_eq!(pair(bad), None, "{bad}");
        }
        // The window gets only the two fields, as the server stores the code.
        assert_eq!(
            pair_url(&PairLink { server: "https://app.agentes.chat".into(), code: "ABCDEFGH".into() }),
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCDEFGH"
        );
    }

    #[test]
    fn link_info() {
        let live = r#"{ "org": { "name": " Acme " }, "by": { "name": "Sam Rivera" }, "kind": "computer", "expiresAt": "2026-11-09T12:10:00.000Z" }"#;
        assert_eq!(
            read_link_info(200, live),
            Ok(LinkInfo {
                org: "Acme".into(),
                by: "Sam Rivera".into(),
                kind: "computer".into(),
                expires_at: "2026-11-09T12:10:00.000Z".into(),
                computer: None,
            })
        );
        assert_eq!(read_link_info(404, r#"{ "error": "link_expired" }"#), Err("link_expired".into()));
        assert_eq!(read_link_info(429, ""), Err("unreachable".into()));
        assert_eq!(read_link_info(200, "<html>"), Err("unreachable".into()));
        assert_eq!(read_link_info(200, &live.replace("computer", "phone")), Err("unreachable".into()));
        assert_eq!(read_link_info(200, &live.replace("Sam Rivera", "")), Err("unreachable".into()));
    }

    #[test]
    fn a_connector_s_sign_in_goes_to_the_site_open_now() {
        let site: Url = "https://app.agentes.chat".parse().unwrap();
        let back: Url = "agenteschat://desktop/connectors/oauth?org=o1&state=s1&code=c%202&other=x".parse().unwrap();
        assert_eq!(
            connector_page(&back, &site).unwrap().as_str(),
            "https://app.agentes.chat/desktop/connector?org=o1&state=s1&code=c+2"
        );
        let refused: Url = "agenteschat://desktop/connectors/oauth?org=o1&error=access_denied".parse().unwrap();
        assert_eq!(
            connector_page(&refused, &site).unwrap().as_str(),
            "https://app.agentes.chat/desktop/connector?org=o1&error=access_denied"
        );
        // A server of the person's own, on its own port; the phone app's link and a connect link aren't this.
        let own: Url = "http://127.0.0.1:4310/".parse().unwrap();
        assert!(connector_page(&back, &own).unwrap().as_str().starts_with("http://127.0.0.1:4310/desktop/connector?"));
        assert!(connector_page(&"agenteschat://connectors/oauth?state=s&code=c".parse().unwrap(), &site).is_none());
        assert!(connector_page(&"agenteschat://connect?server=x".parse().unwrap(), &site).is_none());
    }
}
