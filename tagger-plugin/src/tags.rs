//! Writing a tag edit into one file, with lofty. Nothing here calls
//! Navidrome, so it is tested natively on real files.
//!
//! The file is changed in place, so it keeps its owner, mode and (on a
//! Synology) its ACLs, which a plugin could not set on a replacement file.
//! It is safe all the same: a copy is made first, and if writing or the
//! check afterwards fails, the copy is put back. A copy left behind by a
//! crash is put back by `recover` before the file is touched again.

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use lofty::config::WriteOptions;
use lofty::prelude::*;
use lofty::tag::items::Timestamp;
use lofty::tag::Tag;
use serde::Deserialize;

/// The fields an edit may change. A missing field is left as it is; an
/// empty one is cleared.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    /// "3", or "3/12" with the total.
    pub track_number: Option<String>,
    /// "1", or "1/2" with the total.
    pub disc_number: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
}

impl Edit {
    /// The names of the fields this edit changes, for the log.
    pub fn fields(&self) -> Vec<&'static str> {
        [
            ("title", &self.title),
            ("artist", &self.artist),
            ("albumArtist", &self.album_artist),
            ("album", &self.album),
            ("trackNumber", &self.track_number),
            ("discNumber", &self.disc_number),
            ("year", &self.year),
            ("genre", &self.genre),
        ]
        .into_iter()
        .filter(|(_, value)| value.is_some())
        .map(|(name, _)| name)
        .collect()
    }
}

#[derive(Debug, PartialEq)]
pub enum Error {
    FileNotFound,
    PathOutsideRoot,
    UnsupportedFormat,
    Invalid(String),
    WriteFailed(String),
}

impl Error {
    /// The code the app shows (see the spec's error codes).
    pub fn code(&self) -> &'static str {
        match self {
            Error::FileNotFound => "FILE_NOT_FOUND",
            Error::PathOutsideRoot => "PATH_OUTSIDE_ROOT",
            Error::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            Error::Invalid(_) => "VALIDATION_FAILED",
            Error::WriteFailed(_) => "WRITE_FAILED",
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Invalid(why) | Error::WriteFailed(why) => write!(f, "{}: {why}", self.code()),
            _ => f.write_str(self.code()),
        }
    }
}

/// Writes `edit` into the file at `path`.
pub fn write(path: &Path, edit: &Edit) -> Result<(), Error> {
    let meta = fs::symlink_metadata(path).map_err(|_| Error::FileNotFound)?;
    // A link could lead out of the library.
    if meta.file_type().is_symlink() {
        return Err(Error::PathOutsideRoot);
    }
    if !meta.is_file() {
        return Err(Error::FileNotFound);
    }
    recover(path)?;

    let file = lofty::read_from_path(path).map_err(|e| {
        if e.is_unknown_format() {
            Error::UnsupportedFormat
        } else {
            Error::WriteFailed(format!("could not read the file: {e}"))
        }
    })?;
    let duration = file.properties().duration();

    // Edit the file's main tag (ID3v2, Vorbis comments, MP4 atoms…). A file
    // without one starts it from whatever other tag it has.
    let tag_type = file.primary_tag_type();
    let mut tag = match (file.primary_tag(), file.first_tag()) {
        (Some(tag), _) => tag.clone(),
        (None, Some(other)) => {
            let mut tag = other.clone();
            tag.re_map(tag_type);
            tag
        }
        (None, None) => Tag::new(tag_type),
    };
    apply(&mut tag, edit)?;

    let backup = backup_path(path);
    copy_synced(path, &backup).map_err(|e| {
        let _ = fs::remove_file(&backup);
        Error::WriteFailed(format!("could not make the safety copy: {e}"))
    })?;

    let written = tag
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| Error::WriteFailed(e.to_string()))
        .and_then(|()| check(path, edit, duration));
    match written {
        Ok(()) => {
            let _ = fs::remove_file(&backup);
            Ok(())
        }
        Err(e) => {
            restore(path, &backup)
                .map_err(|r| Error::WriteFailed(format!("{e}; restoring the original also failed: {r}")))?;
            Err(e)
        }
    }
}

/// Puts back the original of `path` if a write to it was cut short.
pub fn recover(path: &Path) -> Result<(), Error> {
    let backup = backup_path(path);
    if backup.exists() {
        restore(path, &backup)
            .map_err(|e| Error::WriteFailed(format!("could not restore an interrupted write: {e}")))?;
    }
    Ok(())
}

/// The safety copy, next to the file and hidden: `.<name>.aonsoku-bs-tagger.bak`.
pub fn backup_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    path.with_file_name(format!(".{name}.aonsoku-bs-tagger.bak"))
}

fn restore(path: &Path, backup: &Path) -> std::io::Result<()> {
    // Copied over the file (not renamed), so it keeps its owner and mode.
    copy_synced(backup, path)?;
    fs::remove_file(backup)
}

fn copy_synced(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::copy(from, to)?;
    File::options().write(true).open(to)?.sync_all()
}

fn apply(tag: &mut Tag, edit: &Edit) -> Result<(), Error> {
    if let Some(v) = &edit.title {
        if v.is_empty() { tag.remove_title() } else { tag.set_title(v.clone()) }
    }
    if let Some(v) = &edit.artist {
        if v.is_empty() { tag.remove_artist() } else { tag.set_artist(v.clone()) }
    }
    if let Some(v) = &edit.album {
        if v.is_empty() { tag.remove_album() } else { tag.set_album(v.clone()) }
    }
    if let Some(v) = &edit.genre {
        if v.is_empty() { tag.remove_genre() } else { tag.set_genre(v.clone()) }
    }
    if let Some(v) = &edit.album_artist {
        tag.remove_key(ItemKey::AlbumArtist);
        if !v.is_empty() {
            tag.insert_text(ItemKey::AlbumArtist, v.clone());
        }
    }
    if let Some(v) = &edit.track_number {
        match number_and_total(v, "trackNumber")? {
            None => {
                tag.remove_track();
                tag.remove_track_total();
            }
            Some((number, total)) => {
                tag.set_track(number);
                match total {
                    Some(total) => tag.set_track_total(total),
                    None => tag.remove_track_total(),
                }
            }
        }
    }
    if let Some(v) = &edit.disc_number {
        match number_and_total(v, "discNumber")? {
            None => {
                tag.remove_disk();
                tag.remove_disk_total();
            }
            Some((number, total)) => {
                tag.set_disk(number);
                match total {
                    Some(total) => tag.set_disk_total(total),
                    None => tag.remove_disk_total(),
                }
            }
        }
    }
    if let Some(v) = &edit.year {
        if v.is_empty() {
            tag.remove_date();
        } else {
            let date = Timestamp::from_str(v.trim())
                .map_err(|_| Error::Invalid(format!("\"{v}\" is not a year or date")))?;
            tag.set_date(date);
        }
    }
    Ok(())
}

/// "" → none, "3" → (3, none), "3/12" → (3, 12).
fn number_and_total(value: &str, field: &str) -> Result<Option<(u32, Option<u32>)>, Error> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let invalid = || Error::Invalid(format!("{field} \"{value}\" is not a number like 3 or 3/12"));
    let (number, total) = match value.split_once('/') {
        Some((n, t)) => (n.trim(), Some(t.trim())),
        None => (value, None),
    };
    let number = number.parse::<u32>().map_err(|_| invalid())?;
    let total = total.map(|t| t.parse::<u32>().map_err(|_| invalid())).transpose()?;
    if number == 0 || total == Some(0) {
        return Err(invalid());
    }
    Ok(Some((number, total)))
}

/// Reads the file back: the edit must be there, and the audio unchanged in
/// length (a damaged file reads differently or not at all).
fn check(path: &Path, edit: &Edit, duration: Duration) -> Result<(), Error> {
    let fail = |why: String| Error::WriteFailed(format!("the file did not read back right: {why}"));
    let file = lofty::read_from_path(path).map_err(|e| fail(e.to_string()))?;
    let diff = file.properties().duration().abs_diff(duration);
    if diff > Duration::from_millis(50) {
        return Err(fail(format!("its length changed by {diff:?}")));
    }
    let tag = file.primary_tag().ok_or_else(|| fail("no tag".into()))?;
    let text = |actual: Option<std::borrow::Cow<'_, str>>, wanted: &Option<String>, name: &str| {
        match wanted {
            Some(w) if actual.as_deref().unwrap_or("") != w.as_str() => Err(fail(format!("{name} is {actual:?}"))),
            _ => Ok(()),
        }
    };
    text(tag.title(), &edit.title, "title")?;
    text(tag.artist(), &edit.artist, "artist")?;
    text(tag.album(), &edit.album, "album")?;
    text(tag.genre(), &edit.genre, "genre")?;
    text(tag.get_string(ItemKey::AlbumArtist).map(Into::into), &edit.album_artist, "albumArtist")?;
    if let Some(v) = &edit.track_number {
        let wanted = number_and_total(v, "trackNumber")?;
        let actual = tag.track().map(|n| (n, tag.track_total()));
        if actual != wanted {
            return Err(fail(format!("trackNumber is {actual:?}")));
        }
    }
    if let Some(v) = &edit.disc_number {
        let wanted = number_and_total(v, "discNumber")?;
        let actual = tag.disk().map(|n| (n, tag.disk_total()));
        if actual != wanted {
            return Err(fail(format!("discNumber is {actual:?}")));
        }
    }
    if let Some(v) = &edit.year {
        let actual = tag.date().map(|d| d.year);
        let wanted = (!v.is_empty()).then(|| Timestamp::from_str(v.trim()).map(|d| d.year).ok()).flatten();
        if actual != wanted {
            return Err(fail(format!("year is {actual:?}")));
        }
    }
    Ok(())
}
