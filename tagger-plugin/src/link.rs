//! The WebSocket to the Aonsoku-BS server.
//!
//! Navidrome neither reconnects a plugin's WebSocket nor notices a dead one,
//! so a scheduled keepalive does both: every 30 s it pings the server, and
//! when nothing has come back for a while it opens the link again. The
//! server answers each ping, so the link counts as alive while it answers.

use std::collections::HashMap;

use extism_pdk::{info, warn};
use nd_pdk::host::{cache, library, scheduler, websocket};
use serde::Deserialize;
use serde_json::json;

use crate::settings::Settings;

pub const CONNECTION_ID: &str = "aonsoku-bs";
pub const KEEPALIVE: &str = "keepalive";
const KEEPALIVE_SCHEDULE: &str = "tagger-keepalive";
const KEEPALIVE_CRON: &str = "@every 30s";
// Set whenever the server is heard from; gone means the link is dead.
const ALIVE_KEY: &str = "link.alive";
const ALIVE_SECONDS: i64 = 75;

/// Plugin start: schedule the keepalive and connect.
pub fn start() -> Result<(), String> {
    let _ = scheduler::cancel_schedule(KEEPALIVE_SCHEDULE);
    scheduler::schedule_recurring(KEEPALIVE_CRON, KEEPALIVE, KEEPALIVE_SCHEDULE)
        .map_err(|e| format!("Could not schedule the keepalive: {e}"))?;
    keepalive();
    Ok(())
}

pub fn keepalive() {
    if is_alive() {
        if send(&json!({ "type": "ping" })).is_ok() {
            return;
        }
        warn!("Lost the connection to the Aonsoku-BS server");
    }
    if let Err(e) = connect() {
        warn!("Could not connect to the Aonsoku-BS server: {e}");
    }
}

fn connect() -> Result<(), String> {
    let settings = Settings::load()?;
    let url = settings.link_url()?;
    // A link Navidrome still holds (dead, or never confirmed) is replaced.
    let _ = websocket::close_connection(CONNECTION_ID, 1000, "Reconnecting");
    let headers = HashMap::from([
        ("Authorization".to_string(), format!("Bearer {}", settings.secret)),
        ("X-Tagger-Version".to_string(), crate::VERSION.to_string()),
    ]);
    websocket::connect(&url, headers, CONNECTION_ID).map_err(|e| e.to_string())?;
    info!("Connected to {url}");
    mark_alive();
    send(&hello())
}

/// What the server shows the app: this plugin and which libraries it can
/// write to (Navidrome's "Allow write access").
fn hello() -> serde_json::Value {
    let libraries: Vec<_> = library::get_all_libraries()
        .unwrap_or_default()
        .into_iter()
        .map(|lib| {
            json!({
                "id": lib.id,
                "name": lib.name,
                "writable": can_write(&lib.mount_point),
            })
        })
        .collect();
    json!({ "type": "hello", "version": crate::VERSION, "libraries": libraries })
}

/// Whether files can be created in a library's mount.
fn can_write(mount_point: &str) -> bool {
    if mount_point.is_empty() {
        return false;
    }
    let probe = format!("{mount_point}/.aonsoku-bs-tagger-check");
    let created = std::fs::write(&probe, b"").is_ok();
    if created {
        let _ = std::fs::remove_file(&probe);
    }
    created
}

#[derive(Deserialize)]
struct Message {
    #[serde(rename = "type")]
    kind: String,
}

pub fn on_message(text: &str) {
    mark_alive();
    let message: Message = match serde_json::from_str(text) {
        Ok(message) => message,
        Err(e) => {
            warn!("Unreadable message from the Aonsoku-BS server: {e}");
            return;
        }
    };
    match message.kind.as_str() {
        "welcome" => info!("The Aonsoku-BS server accepted the connection"),
        "pong" => {}
        other => warn!("Unknown message from the Aonsoku-BS server: {other}"),
    }
}

pub fn on_closed() {
    let _ = cache::remove(ALIVE_KEY);
}

pub fn send(message: &serde_json::Value) -> Result<(), String> {
    websocket::send_text(CONNECTION_ID, &message.to_string()).map_err(|e| e.to_string())
}

fn mark_alive() {
    let _ = cache::set_string(ALIVE_KEY, "1", ALIVE_SECONDS);
}

fn is_alive() -> bool {
    cache::has(ALIVE_KEY).unwrap_or(false)
}
