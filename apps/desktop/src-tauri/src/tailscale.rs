//! Tailscale on this computer, through its own command-line tool: whether it is connected (Connect's
//! discovery, the reach card), and sharing the server here on the person's tailnet (`tailscale serve`, HTTPS
//! inside the tailnet only; never Funnel). The tool is looked up at the places it installs itself, never at a
//! path from a page.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::{Cut, Watch};

/// `status` gets this long to answer.
const STATUS_WAIT: Duration = Duration::from_secs(2);
/// `serve` gets this long when it asks for nothing.
const SERVE_WAIT: Duration = Duration::from_secs(20);
/// Once `serve` asks for HTTPS to be allowed in the tailnet's admin page, it waits there for the person: this long
/// in all, unless they stop waiting.
const APPROVE_WAIT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Tailnet {
    /// No Tailscale on this computer.
    Missing,
    /// Installed, signed out or turned off. `app`: Tailscale's Mac app is there to open, not only its command-line
    /// tool (Homebrew's).
    Off { app: bool },
    /// Connected: this device's own name on the tailnet (`ana-mac.tail1234.ts.net`).
    #[serde(rename_all = "camelCase")]
    On { device: String },
}

/// Why sharing the server here on the tailnet didn't work.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum ServeError {
    /// HTTPS (or Serve) is off for the tailnet: its admin turns it on at `url`.
    Https { url: Option<String> },
    /// This computer's user may not change what Tailscale shares (Linux, until `tailscale set --operator`).
    Operator,
    /// Tailscale is missing, or refused (the Mac App Store variant may never share).
    Serve,
    /// Tailscale is installed but not connected on this computer: connecting it (its app, or `tailscale up`) fixes it.
    NotConnected { app: bool },
    /// The person stopped waiting for HTTPS to be allowed.
    Stopped,
    /// Tailscale shares it, but the server didn't answer again at its new address (not Tailscale's doing).
    Start,
    /// Reach was turned off, and the server didn't answer again at this computer's own address.
    Back,
}

/// Tailscale's Mac app, which "Open Tailscale" opens.
const MAC_APP: &str = "/Applications/Tailscale.app";

/// The tool at the places it installs itself.
pub fn cli() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let fixed: &[&str] = &[
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
    ];
    #[cfg(target_os = "windows")]
    let fixed: &[&str] = &[r"C:\Program Files\Tailscale\tailscale.exe"];
    #[cfg(target_os = "linux")]
    let fixed: &[&str] = &["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let fixed: &[&str] = &[];
    fixed.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Runs the tool with `args`: whether it ended well, and what it printed (stdout, then stderr); None when it isn't
/// there or couldn't start. Taking longer than `wait` stops it (what it printed so far is kept).
fn run(args: &[&str], wait: Duration) -> Option<(bool, String)> {
    let ran = crate::run_program(Command::new(cli()?).args(args), wait, &|| false).ok()?;
    Some((ran.code == Some(0), ran.out + &ran.err))
}

/// `tailscale status --json`, or None when the tool isn't there, fails or takes too long.
pub fn status_json() -> Option<Value> {
    let (ok, out) = run(&["status", "--json"], STATUS_WAIT)?;
    if !ok {
        return None;
    }
    serde_json::from_str(&out).ok()
}

/// What `status --json` says about this device; `app`: whether Tailscale's Mac app is there.
pub fn tailnet_of(status: Option<&Value>, installed: bool, app: bool) -> Tailnet {
    let Some(status) = status else {
        return if installed { Tailnet::Off { app } } else { Tailnet::Missing };
    };
    let running = status.get("BackendState").and_then(Value::as_str) == Some("Running");
    let device = status
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|n| n.trim_end_matches('.').to_ascii_lowercase())
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'));
    match (running, device) {
        (true, Some(device)) => Tailnet::On { device },
        _ => Tailnet::Off { app },
    }
}

pub fn tailnet() -> Tailnet {
    tailnet_of(status_json().as_ref(), cli().is_some(), cfg!(target_os = "macos") && Path::new(MAC_APP).is_dir())
}

/// The HTTPS port to share on: 443, unless this device already shares something else there.
fn https_port(serve: Option<&Value>, device: &str, target: &str) -> u16 {
    let ours = |v: &Value| v.to_string().contains(target);
    let taken = serve
        .and_then(|s| s.pointer(&format!("/Web/{}:443", device.replace('~', "~0").replace('/', "~1"))))
        .is_some_and(|handlers| !ours(handlers));
    if taken {
        8443
    } else {
        443
    }
}

/// The tailnet's admin page `serve` named, where HTTPS (or Serve) is allowed.
fn admin_url(out: &str) -> Option<String> {
    out.split_whitespace()
        .find(|w| w.starts_with("https://login.tailscale.com/"))
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

/// Why `serve` failed, from what it printed.
pub fn serve_error(out: &str) -> ServeError {
    let lower = out.to_ascii_lowercase();
    let url = admin_url(out);
    if url.is_some() || lower.contains("https") && (lower.contains("not enabled") || lower.contains("certificate")) {
        ServeError::Https { url }
    } else if lower.contains("access denied") || lower.contains("operator") {
        ServeError::Operator
    } else {
        ServeError::Serve
    }
}

/// Shares `http://127.0.0.1:<port>` on the tailnet over HTTPS; the address it answers at. When HTTPS isn't
/// allowed in the tailnet yet, Tailscale names its admin page and waits there until it is: `asks` gets that page
/// at once, and `serve` goes on by itself once the person allowed it (up to `APPROVE_WAIT`), unless `stopped`.
pub fn serve(port: u16, asks: &mut dyn FnMut(&str), stopped: &dyn Fn() -> bool) -> Result<String, ServeError> {
    let device = match tailnet() {
        Tailnet::On { device } => device,
        Tailnet::Off { app } => return Err(ServeError::NotConnected { app }),
        Tailnet::Missing => return Err(ServeError::Serve),
    };
    let target = format!("http://127.0.0.1:{port}");
    let current = run(&["serve", "status", "--json"], STATUS_WAIT).and_then(|(_, out)| serde_json::from_str(&out).ok());
    let https = https_port(current.as_ref(), &device, &target);
    let flag = format!("--https={https}");
    let cli = cli().ok_or(ServeError::Serve)?;
    let mut asked = false;
    let mut watch = |so_far: &str| {
        if stopped() {
            return Watch::Stop;
        }
        if !asked {
            if let Some(url) = admin_url(so_far) {
                asked = true;
                asks(&url);
            }
        }
        if asked {
            Watch::WaitUpTo(APPROVE_WAIT)
        } else {
            Watch::Wait
        }
    };
    let mut command = Command::new(cli);
    command.args(["serve", "--bg", flag.as_str(), target.as_str()]);
    let ran = crate::run_watched(&mut command, SERVE_WAIT, &mut watch).map_err(|_| ServeError::Serve)?;
    match ran.cut {
        Some(Cut::Stopped) => Err(ServeError::Stopped),
        _ if ran.code == Some(0) => {
            Ok(if https == 443 { format!("https://{device}") } else { format!("https://{device}:{https}") })
        }
        _ => Err(serve_error(&(ran.out + &ran.err))),
    }
}

/// Stops sharing `port`'s address (either HTTPS port the app may have used).
pub fn unserve(public_url: &str) {
    let https = if public_url.rsplit_once(':').is_some_and(|(_, p)| p == "8443") { 8443 } else { 443 };
    let _ = run(&["serve", &format!("--https={https}"), "off"], SERVE_WAIT);
}

#[tauri::command]
pub async fn tailscale_status(webview: tauri::Webview) -> Result<Tailnet, String> {
    if !matches!(webview.label(), "welcome" | "prefs" | "main-cover") {
        return Err("only the app's own windows ask this".into());
    }
    tauri::async_runtime::spawn_blocking(tailnet).await.map_err(|e| e.to_string())
}

/// "Open Tailscale" (its app, on a Mac that has it: elsewhere it is connected from its icon by the clock or the
/// terminal), "Get Tailscale" (its download page), "Turn it on" (the admin page the last `serve` named, or the
/// tailnet's DNS settings, where HTTPS is turned on).
#[tauri::command]
pub fn tailscale_open(app: tauri::AppHandle, webview: tauri::Webview, page: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !matches!(webview.label(), "welcome" | "prefs" | "main-cover") {
        return Err("only the app's own windows open this".into());
    }
    match page.as_str() {
        "app" if cfg!(target_os = "macos") => app
            .opener()
            .open_path(MAC_APP, None::<&str>)
            .map_err(|e| e.to_string()),
        "download" => app.opener().open_url("https://tailscale.com/download", None::<&str>).map_err(|e| e.to_string()),
        "https" => {
            let url = crate::local_server::https_admin_url(&app)
                .unwrap_or_else(|| "https://login.tailscale.com/admin/dns".to_string());
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
        }
        _ => Err("unknown page".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn why_it_wasnt_shared_as_the_windows_read_it() {
        assert_eq!(
            serde_json::to_value(ServeError::NotConnected { app: true }).unwrap(),
            json!({ "reason": "notConnected", "app": true })
        );
        assert_eq!(serde_json::to_value(ServeError::Back).unwrap(), json!({ "reason": "back" }));
    }

    #[test]
    fn this_device_on_the_tailnet() {
        let on = json!({ "BackendState": "Running", "Self": { "DNSName": "Ana-Mac.tail1234.ts.net." } });
        assert_eq!(tailnet_of(Some(&on), true, true), Tailnet::On { device: "ana-mac.tail1234.ts.net".into() });
        let off = json!({ "BackendState": "Stopped", "Self": { "DNSName": "ana-mac.tail1234.ts.net." } });
        assert_eq!(tailnet_of(Some(&off), true, true), Tailnet::Off { app: true });
        assert_eq!(tailnet_of(None, true, true), Tailnet::Off { app: true });
        // Only the command-line tool (Homebrew's on a Mac): no app to open.
        assert_eq!(tailnet_of(Some(&off), true, false), Tailnet::Off { app: false });
        assert_eq!(tailnet_of(None, false, false), Tailnet::Missing);
        let odd = json!({ "BackendState": "Running", "Self": { "DNSName": "evil name/../x." } });
        assert_eq!(tailnet_of(Some(&odd), true, true), Tailnet::Off { app: true });
        assert_eq!(serde_json::to_value(Tailnet::Off { app: false }).unwrap(), json!({ "state": "off", "app": false }));
    }

    #[test]
    fn https_on_443_unless_something_else_is_there() {
        let target = "http://127.0.0.1:4310";
        let device = "ana-mac.tail1234.ts.net";
        assert_eq!(https_port(None, device, target), 443);
        let ours = json!({ "Web": { "ana-mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": target } } } } });
        assert_eq!(https_port(Some(&ours), device, target), 443);
        let other = json!({ "Web": { "ana-mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8080" } } } } });
        assert_eq!(https_port(Some(&other), device, target), 8443);
    }

    #[test]
    fn why_serve_failed() {
        assert_eq!(
            serve_error("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n"),
            ServeError::Https { url: Some("https://login.tailscale.com/f/serve?node=abc".into()) }
        );
        assert_eq!(serve_error("HTTPS is not enabled for this tailnet"), ServeError::Https { url: None });
        assert_eq!(serve_error("Access denied: serve config denied"), ServeError::Operator);
        assert_eq!(serve_error("something else"), ServeError::Serve);
    }
}
