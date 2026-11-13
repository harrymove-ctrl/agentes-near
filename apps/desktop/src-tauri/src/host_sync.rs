//! This computer as the server here's own computer for agents (ADR 0060 §3), with no code: the server knows
//! `HOST_COMPUTER_TOKEN` (`local_server.rs` wrote it), and `agentes-runner host --once` trades it for one
//! connection per organization the server serves here, written as homes in `~/.agentes-runner/orgs/<orgId>`
//! (`managedBy: "host"`, pointing at the loopback address) without starting anything. The app then runs each
//! home's runner itself, as it runs every home (`Runners::rescan`). It syncs when the server answers, every
//! minute, at once when the site reports a new organization, and with `--rotate` for a home whose token the
//! server refused. A new home gets the app's first tools from the popover (`host://new`).

use std::process::Command;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::local_server;

const EVERY: Duration = Duration::from_secs(60);
/// `host --once` answers in a second or two: past this it is stuck (it holds the sync's lock meanwhile), and the
/// next minute's sync tries again.
const SYNC_WAIT: Duration = Duration::from_secs(60);
pub const NEW_HOME_EVENT: &str = "host://new";

#[derive(Default)]
pub struct HostSync {
    wake: Mutex<bool>,
    ring: Condvar,
    /// One sync at a time (the runner takes no lock of its own for `--once`).
    running: Mutex<()>,
}

/// This computer's name for the server (Settings › Computers): the Mac's own, else its host name.
pub(crate) fn computer_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("scutil").args(["--get", "ComputerName"]).output().ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!name.is_empty() && name.chars().count() <= 64).then_some(name)
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// The one JSON line of `host --once`: the homes written (`new`: made now) and the organizations gone.
pub fn parse(stdout: &[u8]) -> Option<(Vec<(String, bool)>, Vec<String>)> {
    let line = String::from_utf8_lossy(stdout);
    let value: Value = serde_json::from_str(line.lines().rev().find(|l| l.starts_with('{'))?).ok()?;
    if value["status"] != "on" {
        return None;
    }
    let ids = |v: &Value| v.as_str().filter(|id| crate::runners::valid_id(id)).map(str::to_string);
    let homes = value["homes"]
        .as_array()?
        .iter()
        .filter_map(|h| Some((ids(&h["orgId"])?, h["new"].as_bool().unwrap_or(false))))
        .collect();
    let gone = value["gone"].as_array().map(|g| g.iter().filter_map(ids).collect()).unwrap_or_default();
    Some((homes, gone))
}

/// One sync now, then the homes it wrote run and the gone ones stop. Nothing while the server here isn't up.
pub fn sync_now(app: &AppHandle, rotate: &[String]) {
    let sync = app.state::<HostSync>();
    let _one = sync.running.lock().unwrap_or_else(|e| e.into_inner());
    if !local_server::is_running(app) {
        return;
    }
    let (Some(folder), Some(runner), Ok(home)) = (local_server::folder(app), local_server::runner_binary(), app.path().home_dir()) else {
        return;
    };
    let Some(server) = local_server::loopback(app) else { return };
    let mut command = Command::new(runner);
    command
        .args(["host", "--once", "--server", &server, "--token-file"])
        .arg(folder.host_token())
        .arg("--state")
        .arg(home.join(".agentes-runner"));
    if let Some(name) = computer_name() {
        command.args(["--name", &name]);
    }
    for org in rotate {
        command.args(["--rotate", org]);
    }
    let Ok(ran) = crate::run_program(&mut command, SYNC_WAIT, &|| local_server::cancelled(app)) else { return };
    let Some((homes, gone)) = parse(ran.out.as_bytes()) else { return };
    let runners = app.state::<crate::runners::Runners>();
    for org in &gone {
        let _ = runners.remove(app, org);
    }
    runners.rescan(app);
    for org in rotate.iter().filter(|o| homes.iter().any(|(id, _)| id == *o)) {
        runners.restart(app, org);
    }
    for (org, fresh) in homes {
        if fresh && runners.has(&org) {
            let _ = app.emit_to("popover", NEW_HOME_EVENT, org);
        }
    }
}

/// A sync soon (the server answered, the site has a new organization).
pub fn trigger(app: &AppHandle) {
    let sync = app.state::<HostSync>();
    *sync.wake.lock().unwrap_or_else(|e| e.into_inner()) = true;
    sync.ring.notify_one();
}

/// Every minute, or sooner when woken, for as long as the app runs (and Tailscale shares the server here again
/// once it can, with reach on).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        {
            let sync = app.state::<HostSync>();
            let woken = sync.wake.lock().unwrap_or_else(|e| e.into_inner());
            let (mut woken, _) = sync
                .ring
                .wait_timeout_while(woken, EVERY, |w| !*w)
                .unwrap_or_else(|e| e.into_inner());
            *woken = false;
        }
        if app.state::<crate::runners::Runners>().is_quitting() {
            return;
        }
        // Tailscale turned off here since: its line says nobody else reaches it, until it is shared again.
        local_server::check_tailnet(&app);
        local_server::ensure_served(&app);
        sync_now(&app, &[]);
    });
}

/// A home this sync wrote, for a server the app runs here (a terminal install's host keeps its own).
pub fn is_host_home(config: &Value, own_server: Option<&str>) -> bool {
    config.get("managedBy").and_then(Value::as_str) == Some("host")
        && own_server.is_some_and(|s| config.get("server").and_then(Value::as_str) == Some(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_line_host_once_prints() {
        let line = br#"{"status":"on","homes":[{"orgId":"0e7c1d2a-0000-4000-8000-000000000001","orgName":"Acme","machineId":"m","home":"/h","new":true},{"orgId":"../x","new":true}],"gone":["0e7c1d2a-0000-4000-8000-000000000002"]}"#;
        let (homes, gone) = parse(line).unwrap();
        assert_eq!(homes, vec![("0e7c1d2a-0000-4000-8000-000000000001".to_string(), true)]);
        assert_eq!(gone, vec!["0e7c1d2a-0000-4000-8000-000000000002".to_string()]);
        assert!(parse(br#"{"status":"refused","homes":[],"gone":[]}"#).is_none());
        assert!(parse(b"not json").is_none());
    }

    #[test]
    fn only_the_server_here_s_host_homes_are_the_app_s() {
        let host = json!({ "managedBy": "host", "server": "http://127.0.0.1:4310" });
        assert!(is_host_home(&host, Some("http://127.0.0.1:4310")));
        assert!(!is_host_home(&host, Some("http://127.0.0.1:3000")), "a terminal install's own host homes");
        assert!(!is_host_home(&host, None));
        assert!(!is_host_home(&json!({ "server": "http://127.0.0.1:4310" }), Some("http://127.0.0.1:4310")));
    }
}
