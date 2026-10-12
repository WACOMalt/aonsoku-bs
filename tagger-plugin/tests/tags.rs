//! Writes edits into real files of every format and reads them back.

use std::fs;
use std::path::{Path, PathBuf};

use aonsoku_bs_tagger::tags::{backup_path, write, Edit, Error};
use lofty::prelude::*;
use lofty::tag::Tag;

const FORMATS: [&str; 7] = ["mp3", "flac", "m4a", "ogg", "opus", "wav", "aiff"];

/// A fresh copy of a fixture in its own temporary folder.
fn copy_of(ext: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(format!("song.{ext}"));
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(format!("song.{ext}"));
    fs::copy(fixture, &path).unwrap();
    (dir, path)
}

fn tag_of(path: &Path) -> Tag {
    let file = lofty::read_from_path(path).unwrap();
    file.primary_tag().cloned().expect("a tag")
}

fn full_edit() -> Edit {
    Edit {
        title: Some("Café Ñandú 東京".into()),
        artist: Some("Ärtist".into()),
        album_artist: Some("Album Ärtist".into()),
        album: Some("Ålbum".into()),
        track_number: Some("3/12".into()),
        disc_number: Some("1/2".into()),
        year: Some("2021".into()),
        genre: Some("Rock".into()),
    }
}

#[test]
fn every_format_round_trips() {
    for ext in FORMATS {
        let (_dir, path) = copy_of(ext);
        let before = lofty::read_from_path(&path).unwrap().properties().duration();
        write(&path, &full_edit()).unwrap_or_else(|e| panic!("{ext}: {e}"));

        let tag = tag_of(&path);
        assert_eq!(tag.title().as_deref(), Some("Café Ñandú 東京"), "{ext}");
        assert_eq!(tag.artist().as_deref(), Some("Ärtist"), "{ext}");
        assert_eq!(tag.get_string(ItemKey::AlbumArtist), Some("Album Ärtist"), "{ext}");
        assert_eq!(tag.album().as_deref(), Some("Ålbum"), "{ext}");
        assert_eq!((tag.track(), tag.track_total()), (Some(3), Some(12)), "{ext}");
        assert_eq!((tag.disk(), tag.disk_total()), (Some(1), Some(2)), "{ext}");
        assert_eq!(tag.date().map(|d| d.year), Some(2021), "{ext}");
        assert_eq!(tag.genre().as_deref(), Some("Rock"), "{ext}");
        assert_eq!(lofty::read_from_path(&path).unwrap().properties().duration(), before, "{ext}");
        assert!(!backup_path(&path).exists(), "{ext}: the safety copy is removed");
    }
}

#[test]
fn only_the_given_fields_change_and_empty_clears() {
    for ext in FORMATS {
        let (_dir, path) = copy_of(ext);
        write(&path, &Edit { title: Some("New".into()), genre: Some(String::new()), ..Edit::default() })
            .unwrap_or_else(|e| panic!("{ext}: {e}"));
        let tag = tag_of(&path);
        assert_eq!(tag.title().as_deref(), Some("New"), "{ext}");
        assert_eq!(tag.genre(), None, "{ext}: cleared");
        assert_eq!(tag.artist().as_deref(), Some("Old Artist"), "{ext}: untouched");
        assert_eq!(tag.album().as_deref(), Some("Old Album"), "{ext}: untouched");
    }
}

#[test]
fn a_track_without_total_drops_the_total() {
    let (_dir, path) = copy_of("flac");
    write(&path, &Edit { track_number: Some("7".into()), ..Edit::default() }).unwrap();
    let tag = tag_of(&path);
    assert_eq!((tag.track(), tag.track_total()), (Some(7), None));
}

#[test]
fn the_audio_is_not_touched() {
    // MP3 and FLAC keep their tags in front of the audio, so the audio is
    // the end of the file, byte for byte.
    for ext in ["mp3", "flac"] {
        let (_dir, path) = copy_of(ext);
        let before = fs::read(&path).unwrap();
        write(&path, &full_edit()).unwrap();
        let after = fs::read(&path).unwrap();
        let audio = 2000.min(before.len() / 2);
        assert_eq!(before[before.len() - audio..], after[after.len() - audio..], "{ext}");
    }
}

#[test]
fn invalid_values_change_nothing() {
    let (_dir, path) = copy_of("mp3");
    let before = fs::read(&path).unwrap();
    for edit in [
        Edit { track_number: Some("three".into()), ..Edit::default() },
        Edit { disc_number: Some("1/0".into()), ..Edit::default() },
        Edit { year: Some("last year".into()), ..Edit::default() },
    ] {
        assert!(matches!(write(&path, &edit), Err(Error::Invalid(_))), "{edit:?}");
    }
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn missing_files_links_and_folders_are_refused() {
    let (dir, path) = copy_of("mp3");
    assert_eq!(write(&dir.path().join("nope.mp3"), &full_edit()), Err(Error::FileNotFound));
    assert_eq!(write(dir.path(), &full_edit()), Err(Error::FileNotFound));
    let link = dir.path().join("link.mp3");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert_eq!(write(&link, &full_edit()), Err(Error::PathOutsideRoot));
}

#[test]
fn not_audio_is_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    fs::write(&path, "not music").unwrap();
    assert_eq!(write(&path, &full_edit()), Err(Error::UnsupportedFormat));
}

#[test]
fn an_interrupted_write_is_undone_first() {
    // A crash mid-write leaves the safety copy and a damaged file.
    let (_dir, path) = copy_of("flac");
    let original = fs::read(&path).unwrap();
    fs::write(backup_path(&path), &original).unwrap();
    fs::write(&path, b"half-written garbage").unwrap();

    write(&path, &Edit { title: Some("After".into()), ..Edit::default() }).unwrap();
    let tag = tag_of(&path);
    assert_eq!(tag.title().as_deref(), Some("After"));
    assert_eq!(tag.artist().as_deref(), Some("Old Artist"), "restored before editing");
    assert!(!backup_path(&path).exists());
}

#[test]
fn the_file_keeps_its_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = copy_of("flac");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let inode = std::os::unix::fs::MetadataExt::ino(&fs::metadata(&path).unwrap());
    write(&path, &full_edit()).unwrap();
    let meta = fs::metadata(&path).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o640);
    assert_eq!(std::os::unix::fs::MetadataExt::ino(&meta), inode, "the same file, not a replacement");
}
