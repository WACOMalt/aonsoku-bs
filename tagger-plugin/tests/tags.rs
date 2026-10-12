//! Writes edits into real files of every format and reads them back.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use aonsoku_bs_tagger::tags::{backup_path, is_front_cover, write, write_folder_cover, Cover, Edit, Error};
use lofty::prelude::*;
use lofty::tag::Tag;

const FORMATS: [&str; 7] = ["mp3", "flac", "m4a", "ogg", "opus", "wav", "aiff"];

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// A fresh copy of a fixture in its own temporary folder.
fn copy_of(ext: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(format!("song.{ext}"));
    fs::copy(fixture(&format!("song.{ext}")), &path).unwrap();
    (dir, path)
}

fn tag_of(path: &Path) -> Tag {
    let file = lofty::read_from_path(path).unwrap();
    file.primary_tag().cloned().expect("a tag")
}

fn jpeg() -> Cover {
    Cover::new("image/jpeg", fs::read(fixture("cover.jpg")).unwrap()).unwrap()
}

fn png() -> Cover {
    Cover::new("image/png", fs::read(fixture("cover.png")).unwrap()).unwrap()
}

fn front_covers(path: &Path) -> Vec<Vec<u8>> {
    let tag = tag_of(path);
    tag.pictures().iter().filter(|p| is_front_cover(&tag, p)).map(|p| p.data().to_vec()).collect()
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

fn edit(f: impl FnOnce(&mut Edit)) -> Edit {
    let mut edit = Edit::default();
    f(&mut edit);
    edit
}

#[test]
fn every_format_round_trips() {
    for ext in FORMATS {
        let (_dir, path) = copy_of(ext);
        let before = lofty::read_from_path(&path).unwrap().properties().duration();
        write(&path, &full_edit(), None).unwrap_or_else(|e| panic!("{ext}: {e}"));

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
        let e = edit(|e| {
            e.title = Some("New".into());
            e.genre = Some(String::new());
        });
        write(&path, &e, None).unwrap_or_else(|e| panic!("{ext}: {e}"));
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
    write(&path, &edit(|e| e.track_number = Some("7".into())), None).unwrap();
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
        write(&path, &full_edit(), Some(&jpeg())).unwrap();
        let after = fs::read(&path).unwrap();
        let audio = 2000.min(before.len() / 2);
        assert_eq!(before[before.len() - audio..], after[after.len() - audio..], "{ext}");
    }
}

#[test]
fn invalid_values_change_nothing() {
    let (_dir, path) = copy_of("mp3");
    let before = fs::read(&path).unwrap();
    for e in [
        edit(|e| e.track_number = Some("three".into())),
        edit(|e| e.disc_number = Some("1/0".into())),
        edit(|e| e.year = Some("last year".into())),
    ] {
        assert!(matches!(write(&path, &e, None), Err(Error::Invalid(_))), "{e:?}");
    }
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn missing_files_links_and_folders_are_refused() {
    let (dir, path) = copy_of("mp3");
    assert_eq!(write(&dir.path().join("nope.mp3"), &full_edit(), None), Err(Error::FileNotFound));
    assert_eq!(write(dir.path(), &full_edit(), None), Err(Error::FileNotFound));
    let link = dir.path().join("link.mp3");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert_eq!(write(&link, &full_edit(), None), Err(Error::PathOutsideRoot));
}

#[test]
fn not_audio_is_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    fs::write(&path, "not music").unwrap();
    assert_eq!(write(&path, &full_edit(), None), Err(Error::UnsupportedFormat));
}

#[test]
fn an_interrupted_write_is_undone_first() {
    // A crash mid-write leaves the safety copy and a damaged file.
    let (_dir, path) = copy_of("flac");
    let original = fs::read(&path).unwrap();
    fs::write(backup_path(&path), &original).unwrap();
    fs::write(&path, b"half-written garbage").unwrap();

    write(&path, &edit(|e| e.title = Some("After".into())), None).unwrap();
    let tag = tag_of(&path);
    assert_eq!(tag.title().as_deref(), Some("After"));
    assert_eq!(tag.artist().as_deref(), Some("Old Artist"), "restored before editing");
    assert!(!backup_path(&path).exists());
}

#[test]
fn the_file_keeps_its_permissions() {
    let (_dir, path) = copy_of("flac");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let inode = fs::metadata(&path).unwrap().ino();
    write(&path, &full_edit(), Some(&jpeg())).unwrap();
    let meta = fs::metadata(&path).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o640);
    assert_eq!(meta.ino(), inode, "the same file, not a replacement");
}

// ── Covers ──

#[test]
fn every_format_takes_a_cover_and_replaces_it() {
    for ext in FORMATS {
        let (_dir, path) = copy_of(ext);
        write(&path, &Edit::default(), Some(&jpeg())).unwrap_or_else(|e| panic!("{ext}: {e}"));
        assert_eq!(front_covers(&path), vec![fs::read(fixture("cover.jpg")).unwrap()], "{ext}");

        // A second cover replaces the first; the tags stay.
        write(&path, &Edit::default(), Some(&png())).unwrap_or_else(|e| panic!("{ext}: {e}"));
        assert_eq!(front_covers(&path), vec![fs::read(fixture("cover.png")).unwrap()], "{ext}");
        assert_eq!(tag_of(&path).artist().as_deref(), Some("Old Artist"), "{ext}");
    }
}

#[test]
fn covers_must_be_jpeg_or_png_images() {
    let jpeg_bytes = fs::read(fixture("cover.jpg")).unwrap();
    assert!(matches!(Cover::new("image/webp", jpeg_bytes.clone()), Err(Error::Invalid(_))));
    assert!(matches!(Cover::new("image/png", jpeg_bytes), Err(Error::Invalid(_))), "the bytes are a JPEG");
    assert!(matches!(Cover::new("image/jpeg", b"<html>".to_vec()), Err(Error::Invalid(_))));
}

#[test]
fn a_folder_without_a_cover_gets_cover_jpg() {
    let dir = tempfile::tempdir().unwrap();
    let written = write_folder_cover(dir.path(), &jpeg()).unwrap();
    assert_eq!(written, dir.path().join("cover.jpg"));
    assert_eq!(fs::read(written).unwrap(), fs::read(fixture("cover.jpg")).unwrap());
}

#[test]
fn the_cover_navidrome_shows_is_replaced_in_place() {
    let dir = tempfile::tempdir().unwrap();
    // Navidrome shows Cover.JPG first (cover.* before folder.*).
    fs::write(dir.path().join("Folder.jpg"), b"old folder").unwrap();
    fs::write(dir.path().join("Cover.JPG"), b"old cover").unwrap();
    let inode = fs::metadata(dir.path().join("Cover.JPG")).unwrap().ino();

    let written = write_folder_cover(dir.path(), &jpeg()).unwrap();
    assert_eq!(written, dir.path().join("Cover.JPG"));
    assert_eq!(fs::read(&written).unwrap(), fs::read(fixture("cover.jpg")).unwrap());
    assert_eq!(fs::metadata(&written).unwrap().ino(), inode, "the same file");
    assert_eq!(fs::read(dir.path().join("Folder.jpg")).unwrap(), b"old folder", "untouched");
    assert!(!backup_path(&written).exists());
}

#[test]
fn a_cover_of_another_kind_takes_its_name() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("folder.png"), b"old png").unwrap();
    let written = write_folder_cover(dir.path(), &jpeg()).unwrap();
    assert_eq!(written, dir.path().join("folder.jpg"));
    assert!(!dir.path().join("folder.png").exists(), "the old image would still show");
}

#[test]
fn a_linked_folder_cover_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("elsewhere.jpg"), b"keep").unwrap();
    std::os::unix::fs::symlink(outside.path().join("elsewhere.jpg"), dir.path().join("cover.jpg")).unwrap();
    assert_eq!(write_folder_cover(dir.path(), &jpeg()), Err(Error::PathOutsideRoot));
    assert_eq!(fs::read(outside.path().join("elsewhere.jpg")).unwrap(), b"keep");
}
