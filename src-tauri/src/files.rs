// Dropped files are copied into %LOCALAPPDATA%\ACT 3\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const MAX_DROPPED_FILES: usize = 20;
const MAX_DROPPED_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DROP_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FOLDER_DEPTH: usize = 8;
const MAX_FOLDER_ENTRIES: usize = 10_000;

const FOLDER_TEXT_EXTENSIONS: &[&str] = &[
    "c", "cc", "conf", "cpp", "cs", "css", "csv", "go", "h", "hpp", "htm", "html",
    "ini", "java", "js", "jsx", "json", "log", "md", "mjs", "py", "rs", "sh", "sql",
    "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("Use the batch document import to select a folder: {source}."));
    }
    if !meta.is_file() {
        return Err(format!("Only regular files can be dropped: {source}."));
    }
    if meta.len() > MAX_DROPPED_FILE_BYTES {
        return Err(format!("{source} is larger than the 10 MB per-file limit."));
    }

    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let (dest, name) = loop {
        let mut selected = None;
        for i in 1..1000 {
            let filename = if i == 1 { name.clone() } else { format!("{stem} ({i}){ext}") };
            let candidate = dir.join(&filename);
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
                Ok(mut output) => {
                    let copy_result = std::fs::File::open(src)
                        .and_then(|mut input| std::io::copy(&mut input, &mut output).map(|_| ()));
                    if let Err(error) = copy_result {
                        let _ = std::fs::remove_file(&candidate);
                        return Err(format!("cannot copy {source}: {error}"));
                    }
                    selected = Some((candidate, filename));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("cannot create inbox copy for {source}: {error}")),
            }
        }
        if let Some(selected) = selected {
            break selected;
        }
        return Err(format!("Could not find an unused inbox filename for {source}."));
    };
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

pub fn ingest_many(sources: &[String]) -> Result<Vec<DroppedFile>, String> {
    if sources.is_empty() {
        return Err("Drop at least one file.".into());
    }
    if sources.len() > MAX_DROPPED_FILES {
        return Err(format!("Drop up to {MAX_DROPPED_FILES} files at a time."));
    }
    let sources = expand_sources(sources)?;
    if sources.len() > MAX_DROPPED_FILES {
        return Err(format!("Drop up to {MAX_DROPPED_FILES} files at a time."));
    }
    let mut total_bytes = 0u64;
    for source in &sources {
        let metadata = std::fs::metadata(source)
            .map_err(|error| format!("Cannot access {source}: {error}"))?;
        if !metadata.is_file() {
            return Err(format!("Only files and folders containing documents can be dropped: {source}."));
        }
        if metadata.len() > MAX_DROPPED_FILE_BYTES {
            return Err(format!("{source} is larger than the 10 MB per-file limit."));
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_DROP_BYTES {
            return Err("The combined drop is larger than the 50 MB limit.".into());
        }
    }

    let mut dropped = Vec::with_capacity(sources.len());
    for source in &sources {
        match ingest(source) {
            Ok(file) => dropped.push(file),
            Err(error) => {
                for copied in &dropped {
                    let _ = std::fs::remove_file(&copied.path);
                }
                return Err(error);
            }
        }
    }
    Ok(dropped)
}

fn expand_sources(sources: &[String]) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut visited_entries = 0;
    for source in sources {
        let path = PathBuf::from(source);
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("Cannot access {source}: {error}"))?;
        if metadata.is_file() {
            add_source(&path, &mut files, &mut seen)?;
        } else if metadata.is_dir() {
            collect_folder(
                &path,
                0,
                &mut visited_entries,
                &mut files,
                &mut seen,
            )?;
        } else {
            return Err(format!("Only files and folders can be dropped: {source}."));
        }
    }
    if files.is_empty() {
        return Err("No PDF or UTF-8 text documents were found in the dropped folder.".into());
    }
    Ok(files)
}

fn collect_folder(
    folder: &Path,
    depth: usize,
    visited_entries: &mut usize,
    files: &mut Vec<String>,
    seen: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_FOLDER_DEPTH {
        return Err(format!(
            "Folder nesting exceeds the {}-level import limit: {}",
            MAX_FOLDER_DEPTH,
            folder.display()
        ));
    }
    let directory = std::fs::read_dir(folder)
        .map_err(|error| format!("Cannot read folder {}: {error}", folder.display()))?;
    let mut entries = Vec::new();
    for entry in directory {
        *visited_entries += 1;
        if *visited_entries > MAX_FOLDER_ENTRIES {
            return Err(format!("Folder import stopped after {MAX_FOLDER_ENTRIES} entries."));
        }
        entries.push(entry.map_err(|error| {
            format!("Cannot list folder {}: {error}", folder.display())
        })?);
    }
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

    for entry in entries {
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|error| format!("Cannot inspect {}: {error}", path.display()))?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if matches!(
                name.as_str(),
                ".git" | "node_modules" | "target" | "dist" | "build" | "vendor" | "bin" | "obj"
            ) {
                continue;
            }
            collect_folder(&path, depth + 1, visited_entries, files, seen)?;
        } else if kind.is_file() && is_folder_document(&path) {
            add_source(&path, files, seen)?;
        }
    }
    Ok(())
}

fn is_folder_document(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("pdf")
                || FOLDER_TEXT_EXTENSIONS
                    .iter()
                    .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

fn add_source(
    path: &Path,
    files: &mut Vec<String>,
    seen: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", path.display()))?;
    if seen.insert(canonical.clone()) {
        files.push(canonical.to_string_lossy().into_owned());
        if files.len() > MAX_DROPPED_FILES {
            return Err(format!(
                "This selection contains more than {MAX_DROPPED_FILES} documents. Choose a smaller folder or select specific files."
            ));
        }
    }
    Ok(())
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("act3-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ingest_many_copies_multiple_files_from_arbitrary_directories() {
        let tmp = std::env::temp_dir().join(format!(
            "act3-multi-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let first_dir = tmp.join("first");
        let second_dir = tmp.join("second");
        std::fs::create_dir_all(&first_dir).unwrap();
        std::fs::create_dir_all(&second_dir).unwrap();
        let first = first_dir.join("paper.pdf");
        let second = second_dir.join("paper.pdf");
        std::fs::write(&first, b"first pdf").unwrap();
        std::fs::write(&second, b"second pdf").unwrap();

        let copied = ingest_many(&[
            first.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
        ])
        .unwrap();
        assert_eq!(copied.len(), 2);
        assert_ne!(copied[0].path, copied[1].path);
        assert_eq!(std::fs::read(&copied[0].path).unwrap(), b"first pdf");
        assert_eq!(std::fs::read(&copied[1].path).unwrap(), b"second pdf");
        for file in copied {
            std::fs::remove_file(file.path).unwrap();
        }
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn ingest_many_expands_folders_and_skips_build_output_and_binary_files() {
        let tmp = std::env::temp_dir().join(format!(
            "act3-folder-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let nested = tmp.join("notes");
        let build = tmp.join("target");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&build).unwrap();
        let first = nested.join("one.txt");
        let second = tmp.join("two.pdf");
        std::fs::write(&first, b"first").unwrap();
        std::fs::write(&second, b"second").unwrap();
        std::fs::write(tmp.join("image.png"), b"not text").unwrap();
        std::fs::write(build.join("generated.rs"), b"generated").unwrap();

        let copied = ingest_many(&[tmp.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(copied.len(), 2);
        assert_eq!(
            copied.iter().map(|file| file.name.as_str()).collect::<Vec<_>>(),
            ["one.txt", "two.pdf"]
        );
        for file in copied {
            std::fs::remove_file(file.path).unwrap();
        }
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn ingest_many_rejects_folder_imports_over_the_document_limit() {
        let tmp = std::env::temp_dir().join(format!(
            "act3-folder-limit-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        for index in 0..=MAX_DROPPED_FILES {
            std::fs::write(tmp.join(format!("{index}.txt")), b"text").unwrap();
        }

        let error = ingest_many(&[tmp.to_string_lossy().into_owned()]).unwrap_err();
        assert!(error.contains("more than 20 documents"));
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn ingest_many_rejects_too_many_files_without_partial_copies() {
        let paths = vec!["missing".to_string(); MAX_DROPPED_FILES + 1];
        let error = match ingest_many(&paths) {
            Ok(_) => panic!("over-limit batch should be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("up to 20 files"));
    }
}
