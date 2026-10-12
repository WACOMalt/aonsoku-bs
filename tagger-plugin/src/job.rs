//! A batch of edits from the Aonsoku-BS server.
//!
//! Every plugin call must finish within 30 s, so a batch becomes one queued
//! task per song (the queue runs one at a time). The editor is checked with
//! Navidrome first: the server already did, but the plugin doesn't take its
//! word for it.

use std::collections::HashMap;
use std::path::{Component, Path};

use base64::Engine;

use extism_pdk::{info, warn};
use nd_pdk::host::{cache, http, library, matcher, subsonicapi, task};
use nd_pdk::types::SongRef;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::link;
use crate::settings::Settings;
use crate::tags::{self, Cover, Edit};

pub const QUEUE: &str = "writes";
const JOB_SECONDS: i64 = 6 * 3600;

/// Subsonic credentials, as the app signed in with them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub u: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteJob {
    job_id: String,
    auth: Credentials,
    items: Vec<Item>,
    /// Each cover once, by id (items name the one they get).
    #[serde(default)]
    covers: HashMap<String, CoverData>,
    /// Also replace the cover image of each edited folder.
    #[serde(default)]
    folder_cover: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverData {
    mime_type: String,
    /// Base64.
    data: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    song_id: String,
    #[serde(default)]
    tags: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cover_id: Option<String>,
}

/// One song of a batch, as queued.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteTask {
    job_id: String,
    user: String,
    item: Item,
    folder_cover: bool,
}

/// Queue setup, at plugin start.
pub fn create_queue() {
    let config = task::QueueConfig {
        concurrency: 1,
        // A failed song is reported, not retried.
        max_retries: 0,
        retention_ms: 3_600_000,
        ..Default::default()
    };
    if let Err(e) = task::create_queue(QUEUE, config) {
        // Already there after a reload.
        info!("Write queue: {e}");
    }
}

/// A "write" message: check the editor, then queue the songs.
pub fn accept(message: &str) {
    let job: WriteJob = match serde_json::from_str(message) {
        Ok(job) => job,
        Err(e) => {
            warn!("Unreadable write request: {e}");
            return;
        }
    };
    if let Err(code) = check_editor(&job.auth) {
        warn!("Refused edits by {}: {code}", job.auth.u);
        for item in &job.items {
            send_result(&job.job_id, &item.song_id, Err(code));
        }
        send_done(&job.job_id, false);
        return;
    }
    // The covers wait in the cache for the songs' tasks.
    for (id, cover) in &job.covers {
        let stored = base64::engine::general_purpose::STANDARD
            .decode(&cover.data)
            .map_err(|e| e.to_string())
            .and_then(|data| {
                cache::set_bytes(&cover_key(&job.job_id, id), data, JOB_SECONDS).map_err(|e| e.to_string())?;
                cache::set_string(&cover_mime_key(&job.job_id, id), &cover.mime_type, JOB_SECONDS)
                    .map_err(|e| e.to_string())
            });
        if let Err(e) = stored {
            warn!("Could not keep cover {id}: {e}");
        }
    }
    let _ = cache::set_string(&folders_key(&job.job_id), "[]", JOB_SECONDS);
    let _ = cache::set_int(&remaining_key(&job.job_id), job.items.len() as i64, JOB_SECONDS);
    for item in job.items {
        let song_id = item.song_id.clone();
        let task = WriteTask {
            job_id: job.job_id.clone(),
            user: job.auth.u.clone(),
            item,
            folder_cover: job.folder_cover,
        };
        let payload = serde_json::to_vec(&task).unwrap_or_default();
        if let Err(e) = task::enqueue(QUEUE, payload) {
            warn!("Could not queue song {song_id}: {e}");
            send_result(&job.job_id, &song_id, Err("WRITE_FAILED"));
            song_done(&job.job_id);
        }
    }
}

/// The editor must sign in to Navidrome and be an admin: getUser with
/// their own credentials checks both.
fn check_editor(auth: &Credentials) -> Result<(), &'static str> {
    let settings = Settings::load().map_err(|_| "TAGGER_UNAVAILABLE")?;
    let mut query = vec![
        ("u", auth.u.as_str()),
        ("v", "1.16.1"),
        ("c", "aonsoku-bs-tagger"),
        ("f", "json"),
        ("username", auth.u.as_str()),
    ];
    match (&auth.t, &auth.s, &auth.p) {
        (Some(t), Some(s), _) => query.extend([("t", t.as_str()), ("s", s.as_str())]),
        (_, _, Some(p)) => query.push(("p", p.as_str())),
        _ => return Err("UNAUTHORIZED"),
    }
    let url = format!("{}/rest/getUser.view?{}", settings.navidrome_url.trim_end_matches('/'), encode_query(&query));
    let response = http::send(http::HTTPRequest {
        method: "GET".into(),
        url,
        timeout_ms: 8000,
        ..Default::default()
    })
    .map_err(|e| {
        warn!("Could not reach Navidrome to check the editor: {e}");
        "TAGGER_UNAVAILABLE"
    })?
    .ok_or("TAGGER_UNAVAILABLE")?;
    let body: serde_json::Value = serde_json::from_slice(&response.body).map_err(|_| "UNAUTHORIZED")?;
    let reply = &body["subsonic-response"];
    if reply["status"] != "ok" {
        return Err("UNAUTHORIZED");
    }
    if reply["user"]["adminRole"] != true {
        return Err("FORBIDDEN");
    }
    Ok(())
}

/// A queued song: find its file, write it, report.
pub fn run(payload: &[u8]) -> Result<String, String> {
    let task: WriteTask = serde_json::from_slice(payload).map_err(|e| format!("Unreadable task: {e}"))?;
    let result = write_song(&task);
    match &result {
        Ok(_) => info!("{} edited song {}: ok", task.user, task.item.song_id),
        Err(code) => warn!("{} edited song {}: {code}", task.user, task.item.song_id),
    }
    if let Ok(folder) = &result {
        remember_folder(&task.job_id, folder);
    }
    send_result(&task.job_id, &task.item.song_id, result.map(|_| ()));
    song_done(&task.job_id);
    Ok(String::new())
}

/// One song of the batch is done; the last one finishes the batch.
fn song_done(job_id: &str) {
    let key = remaining_key(job_id);
    let left = cache::get_int(&key).ok().flatten().unwrap_or(1) - 1;
    if left > 0 {
        let _ = cache::set_int(&key, left, JOB_SECONDS);
    } else {
        let _ = cache::remove(&key);
        finish(job_id);
    }
}

fn load_cover(job_id: &str, cover_id: &str) -> Result<Cover, &'static str> {
    let data = cache::get_bytes(&cover_key(job_id, cover_id)).ok().flatten().ok_or("WRITE_FAILED")?;
    let mime = cache::get_string(&cover_mime_key(job_id, cover_id)).ok().flatten().ok_or("WRITE_FAILED")?;
    Cover::new(&mime, data).map_err(|e| e.code())
}

/// Writes one song; its folder, for the rescan.
fn write_song(task: &WriteTask) -> Result<(i32, String), &'static str> {
    let tags = if task.item.tags.is_null() { serde_json::json!({}) } else { task.item.tags.clone() };
    let edit: Edit = serde_json::from_value(tags).map_err(|_| "VALIDATION_FAILED")?;
    let cover = task.item.cover_id.as_deref().map(|id| load_cover(&task.job_id, id)).transpose()?;
    let found = matcher::match_songs(
        vec![SongRef { id: task.item.song_id.clone(), ..Default::default() }],
        matcher::MatchOptions { username: task.user.clone() },
    )
    .map_err(|e| {
        warn!("Could not look up song {}: {e}", task.item.song_id);
        "FILE_NOT_FOUND"
    })?;
    let track = found.into_iter().next().flatten().ok_or("FILE_NOT_FOUND")?;
    if track.missing || track.id != task.item.song_id {
        return Err("FILE_NOT_FOUND");
    }
    let library = library::get_library(track.library_id)
        .ok()
        .flatten()
        .filter(|lib| !lib.mount_point.is_empty())
        .ok_or("FILE_NOT_FOUND")?;
    let relative = safe_relative(&track.path).ok_or("PATH_OUTSIDE_ROOT")?;
    let path = Path::new(&library.mount_point).join(relative);
    let mut changes = edit.fields();
    if cover.is_some() {
        changes.push("cover");
    }
    info!("{} edits {} ({})", task.user, track.path, changes.join(", "));
    tags::write(&path, &edit, cover.as_ref()).map_err(|e| {
        warn!("Writing {} failed: {e}", track.path);
        e.code()
    })?;
    let folder = relative.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();

    // The folder's own cover image, once per folder and batch. A failure
    // there is logged: the song itself is written.
    if let (true, Some(cover)) = (task.folder_cover, &cover) {
        let key = format!("job.{}.cover-folder.{}:{}", task.job_id, track.library_id, folder);
        if !cache::has(&key).unwrap_or(false) {
            let dir = path.parent().unwrap_or(Path::new(&library.mount_point));
            match tags::write_folder_cover(dir, cover) {
                Ok(written) => info!("{} replaced the cover image {}", task.user, written.display()),
                Err(e) => warn!("Could not replace the cover image in {folder}: {e}"),
            }
            let _ = cache::set_string(&key, "1", JOB_SECONDS);
        }
    }
    Ok((track.library_id, folder))
}

/// A library-relative path that stays inside the library.
fn safe_relative(path: &str) -> Option<&Path> {
    let path = Path::new(path);
    let inside = path.components().all(|c| matches!(c, Component::Normal(_)));
    (inside && !path.as_os_str().is_empty()).then_some(path)
}

/// The batch is done: rescan the edited folders, then tell the server.
fn finish(job_id: &str) {
    let folders = take_folders(job_id);
    let scanned = !folders.is_empty() && rescan(&folders);
    send_done(job_id, scanned);
}

fn rescan(folders: &[(i32, String)]) -> bool {
    let Ok(settings) = Settings::load() else { return false };
    let mut query = vec![("u".to_string(), settings.scan_user.clone())];
    for (library_id, folder) in folders {
        query.push(("target".to_string(), format!("{library_id}:{folder}")));
    }
    let pairs: Vec<(&str, &str)> = query.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    match subsonicapi::call(&format!("startScan?{}", encode_query(&pairs))) {
        Ok(_) => true,
        Err(e) => {
            warn!("Could not rescan the edited folders as {}: {e}", settings.scan_user);
            false
        }
    }
}

fn remaining_key(job_id: &str) -> String {
    format!("job.{job_id}.remaining")
}

fn cover_key(job_id: &str, cover_id: &str) -> String {
    format!("job.{job_id}.cover.{cover_id}")
}

fn cover_mime_key(job_id: &str, cover_id: &str) -> String {
    format!("job.{job_id}.cover.{cover_id}.mime")
}

fn folders_key(job_id: &str) -> String {
    format!("job.{job_id}.folders")
}

fn remember_folder(job_id: &str, folder: &(i32, String)) {
    let key = folders_key(job_id);
    let mut folders: Vec<(i32, String)> = cache::get_string(&key)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if !folders.contains(folder) {
        folders.push(folder.clone());
    }
    let _ = cache::set_string(&key, &serde_json::to_string(&folders).unwrap_or_default(), JOB_SECONDS);
}

fn take_folders(job_id: &str) -> Vec<(i32, String)> {
    let key = folders_key(job_id);
    let folders = cache::get_string(&key)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let _ = cache::remove(&key);
    folders
}

fn send_result(job_id: &str, song_id: &str, result: Result<(), &str>) {
    let message = match result {
        Ok(()) => json!({ "type": "result", "jobId": job_id, "songId": song_id, "ok": true }),
        Err(code) => json!({ "type": "result", "jobId": job_id, "songId": song_id, "ok": false, "error": code }),
    };
    if let Err(e) = link::send(&message) {
        warn!("Could not report song {song_id}: {e}");
    }
}

fn send_done(job_id: &str, scan_triggered: bool) {
    if let Err(e) = link::send(&json!({ "type": "done", "jobId": job_id, "scanTriggered": scan_triggered })) {
        warn!("Could not report the end of batch {job_id}: {e}");
    }
}

/// `a=1&b=x%20y`: query values, percent-encoded.
pub fn encode_query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{encode_query, safe_relative};

    #[test]
    fn only_paths_inside_the_library_are_used() {
        assert!(safe_relative("Artist/Album/01 - Song.flac").is_some());
        assert!(safe_relative("../outside.flac").is_none());
        assert!(safe_relative("Artist/../../outside.flac").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        assert!(safe_relative("./song.flac").is_none());
        assert!(safe_relative("").is_none());
    }

    #[test]
    fn query_values_are_encoded() {
        assert_eq!(
            encode_query(&[("target", "1:Test Artist/Ünï"), ("u", "a&b")]),
            "target=1%3ATest%20Artist%2F%C3%9Cn%C3%AF&u=a%26b"
        );
    }
}
