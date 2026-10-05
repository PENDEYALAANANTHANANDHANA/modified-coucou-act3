use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_TEXT_BYTES: u64 = 1_000_000;
const MAX_RESULTS: usize = 100;
const MAX_WORKSPACE_FILES: usize = 40;
const MAX_WORKSPACE_BYTES: usize = 200_000;
const MAX_CODE_CHANGES: usize = 12;
const ALLOWED_TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "js", "ts", "tsx", "jsx", "css", "html", "rs", "toml",
    "yaml", "yml", "csv", "log",
];
const CODE_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "json", "jsx",
    "md", "mjs", "php", "py", "rb", "rs", "sh", "sql", "svelte", "swift", "ts", "tsx", "vue",
    "xml", "yaml", "yml",
];
const IGNORED_DIRECTORIES: &[&str] = &[
    ".git", ".next", ".nuxt", ".venv", "build", "coverage", "dist", "node_modules", "target",
    "vendor",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFile {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeChange {
    pub path: String,
    pub original_contents: Option<String>,
    pub contents: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedCodeChange {
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeProposal {
    pub summary: String,
    pub changes: Vec<CodeChange>,
}

fn root_dir(root: &str) -> Result<PathBuf, String> {
    let root = Path::new(root);
    let canonical = root.canonicalize().map_err(|e| format!("Search root is not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err("Search root must be a folder.".into());
    }
    Ok(canonical)
}

fn confined_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() || Path::new(relative).is_absolute() {
        return Err("File path must be relative to the search root.".into());
    }
    let candidate = root.join(relative);
    let canonical = candidate.canonicalize().map_err(|e| format!("File is not accessible: {e}"))?;
    if !canonical.starts_with(root) {
        return Err("File path escapes the selected search root.".into());
    }
    Ok(canonical)
}

pub fn search(root: &str, query: &str) -> Result<Vec<FileMatch>, String> {
    let root = root_dir(root)?;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Err("Enter a file-name search.".into());
    }
    let mut results = Vec::new();
    let mut pending = vec![root.clone()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("Cannot scan folder: {e}"))? {
            let entry = entry.map_err(|e| format!("Cannot read folder entry: {e}"))?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|e| format!("Cannot inspect entry: {e}"))?;
            if metadata.is_dir() {
                pending.push(path);
            } else if path.file_name().map(|n| n.to_string_lossy().to_lowercase().contains(&query)).unwrap_or(false) {
                let relative = path.strip_prefix(&root).map_err(|_| "Could not make a safe relative path.".to_string())?;
                results.push(FileMatch {
                    path: relative.to_string_lossy().to_string(),
                    name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                    size: metadata.len(),
                });
                if results.len() >= MAX_RESULTS {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}

pub fn workspace_files(root: &str) -> Result<Vec<(String, String)>, String> {
    let root = root_dir(root)?;
    let mut pending = vec![root.clone()];
    let mut candidates = Vec::new();
    let mut visited = 0usize;

    while let Some(dir) = pending.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|error| format!("Cannot scan workspace folder: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("Cannot read workspace entry: {error}"))?;
            visited += 1;
            if visited > 10_000 {
                return Err("Workspace is too large to scan safely.".into());
            }
            let kind = entry.file_type().map_err(|error| format!("Cannot inspect workspace entry: {error}"))?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if !IGNORED_DIRECTORIES.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    pending.push(entry.path());
                }
                continue;
            }
            if !kind.is_file() || !is_code_file(&entry.path()) {
                continue;
            }
            let metadata = entry.metadata().map_err(|error| format!("Cannot inspect source file: {error}"))?;
            let relative = entry.path().strip_prefix(&root)
                .map_err(|_| "A workspace file is outside the selected folder.".to_string())?
                .to_string_lossy().replace('\\', "/");
            candidates.push((relative, entry.path(), metadata.len()));
        }
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    let mut files = Vec::new();
    let mut total_bytes = 0usize;
    for (relative, path, size) in candidates {
        if size > 24_000 || total_bytes + size as usize > MAX_WORKSPACE_BYTES {
            continue;
        }
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(_) => continue,
        };
        total_bytes += contents.len();
        files.push((relative, contents));
        if files.len() >= MAX_WORKSPACE_FILES || total_bytes >= MAX_WORKSPACE_BYTES {
            break;
        }
    }
    Ok(files)
}

pub fn prepare_code_proposal(
    root: &str,
    summary: String,
    proposed: Vec<ProposedCodeChange>,
    included_files: &[String],
) -> Result<CodeProposal, String> {
    if proposed.is_empty() {
        return Err("The model did not propose any file changes.".into());
    }
    if proposed.len() > MAX_CODE_CHANGES {
        return Err(format!("A single change is limited to {MAX_CODE_CHANGES} files."));
    }
    let root = root_dir(root)?;
    let included: std::collections::HashSet<String> = included_files
        .iter()
        .map(|path| path.replace('\\', "/").to_lowercase())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut changes = Vec::with_capacity(proposed.len());
    let mut total_bytes = 0usize;
    for change in proposed {
        let relative = Path::new(&change.path);
        if relative.is_absolute()
            || relative.components().any(|part| !matches!(part, std::path::Component::Normal(_)))
            || !is_code_file(relative)
        {
            return Err(format!("The model proposed an unsafe or unsupported path: {}", change.path));
        }
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if !seen.insert(normalized.to_lowercase()) {
            return Err(format!("The model proposed {} more than once.", change.path));
        }
        total_bytes = total_bytes.saturating_add(change.contents.len());
        if change.contents.len() as u64 > MAX_TEXT_BYTES || total_bytes > MAX_WORKSPACE_BYTES {
            return Err("Generated code changes exceed the 200 KB total output limit.".into());
        }
        let candidate = root.join(relative);
        let parent = candidate.parent().ok_or_else(|| "Invalid code file path.".to_string())?;
        let canonical_parent = parent.canonicalize()
            .map_err(|error| format!("Parent folder for {} is not accessible: {error}", change.path))?;
        if !canonical_parent.starts_with(&root) {
            return Err(format!("{} points outside the selected workspace.", change.path));
        }
        let original_contents = if candidate.exists() {
            if !included.contains(&normalized.to_lowercase()) {
                return Err(format!("{} was not included in the project context; refusing to replace an unseen file.", change.path));
            }
            let canonical = candidate.canonicalize()
                .map_err(|error| format!("Cannot inspect {}: {error}", change.path))?;
            if !canonical.starts_with(&root) || !canonical.is_file() {
                return Err(format!("{} is not a safe workspace file.", change.path));
            }
            let metadata = std::fs::metadata(&canonical)
                .map_err(|error| format!("Cannot inspect {}: {error}", change.path))?;
            if metadata.len() > MAX_TEXT_BYTES {
                return Err(format!("{} exceeds the 1 MB file limit.", change.path));
            }
            Some(std::fs::read_to_string(canonical)
                .map_err(|error| format!("Cannot read {}: {error}", change.path))?)
        } else {
            None
        };
        changes.push(CodeChange {
            path: normalized,
            original_contents,
            contents: change.contents,
        });
    }
    Ok(CodeProposal { summary, changes })
}

pub fn apply_code_changes(root: &str, changes: &[CodeChange]) -> Result<Vec<String>, String> {
    if changes.is_empty() || changes.len() > MAX_CODE_CHANGES {
        return Err(format!("Choose between 1 and {MAX_CODE_CHANGES} file changes to apply."));
    }
    let root = root_dir(root)?;
    let mut prepared = Vec::with_capacity(changes.len());
    let mut seen = std::collections::HashSet::new();
    for change in changes {
        let relative = Path::new(&change.path);
        if relative.is_absolute()
            || relative.components().any(|part| !matches!(part, std::path::Component::Normal(_)))
            || !is_code_file(relative)
        {
            return Err(format!("Refusing unsafe code path: {}", change.path));
        }
        let normalized = relative.to_string_lossy().replace('\\', "/").to_lowercase();
        if !seen.insert(normalized) {
            return Err(format!("Duplicate code path: {}", change.path));
        }
        if change.contents.len() as u64 > MAX_TEXT_BYTES {
            return Err(format!("{} exceeds the 1 MB file limit.", change.path));
        }
        let candidate = root.join(relative);
        let parent = candidate.parent().ok_or_else(|| "Invalid code file path.".to_string())?;
        let canonical_parent = parent.canonicalize()
            .map_err(|error| format!("Parent folder for {} is not accessible: {error}", change.path))?;
        if !canonical_parent.starts_with(&root) {
            return Err(format!("{} points outside the selected workspace.", change.path));
        }
        match &change.original_contents {
            Some(original) => {
                let canonical = candidate.canonicalize()
                    .map_err(|error| format!("{} changed since the proposal: {error}", change.path))?;
                if !canonical.starts_with(&root) || !canonical.is_file() {
                    return Err(format!("{} is no longer a safe workspace file.", change.path));
                }
                let current = std::fs::read_to_string(&canonical)
                    .map_err(|error| format!("Cannot read {} before applying: {error}", change.path))?;
                if &current != original {
                    return Err(format!("{} changed after the proposal. Generate the edits again before applying.", change.path));
                }
                prepared.push((canonical, change, Some(current)));
            }
            None => {
                if candidate.exists() {
                    return Err(format!("{} now exists. Generate the edits again before applying.", change.path));
                }
                prepared.push((candidate, change, None));
            }
        }
    }

    let mut written: Vec<(PathBuf, Option<String>)> = Vec::with_capacity(prepared.len());
    for (path, change, original) in &prepared {
        let result = match original {
            Some(_) => std::fs::write(path, &change.contents),
            None => std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .and_then(|mut file| std::io::Write::write_all(&mut file, change.contents.as_bytes())),
        };
        if let Err(error) = result {
            let mut rollback_errors = Vec::new();
            match original {
                Some(contents) => {
                    if let Err(rollback_error) = std::fs::write(path, contents) {
                        rollback_errors.push(format!("{} ({rollback_error})", path.display()));
                    }
                }
                None if error.kind() != std::io::ErrorKind::AlreadyExists && path.exists() => {
                    if let Err(rollback_error) = std::fs::remove_file(path) {
                        rollback_errors.push(format!("{} ({rollback_error})", path.display()));
                    }
                }
                None => {}
            }
            for (written_path, previous) in written.iter().rev() {
                let rollback = match previous {
                    Some(contents) => std::fs::write(written_path, contents),
                    None => std::fs::remove_file(written_path),
                };
                if let Err(rollback_error) = rollback {
                    rollback_errors.push(format!("{} ({rollback_error})", written_path.display()));
                }
            }
            let message = match original {
                Some(_) => format!("Could not update {}: {error}", change.path),
                None if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    format!("{} now exists. No files were kept partially changed.", change.path)
                }
                None => format!("Could not create {}: {error}", change.path),
            };
            if rollback_errors.is_empty() {
                return Err(message);
            }
            return Err(format!("{message}; rollback also failed for {}", rollback_errors.join(", ")));
        }
        written.push((path.clone(), original.clone()));
    }
    Ok(prepared.into_iter().map(|(_, change, _)| change.path.clone()).collect())
}

pub fn read_text(root: &str, relative: &str) -> Result<String, String> {
    let root = root_dir(root)?;
    let path = confined_path(&root, relative)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Cannot inspect file: {e}"))?;
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("Text file is larger than the 1 MB safety limit.".into());
    }
    if !is_text_file(&path) {
        return Err("Only common text/code file types can be read.".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("Cannot read text file: {e}"))
}

pub fn read_user_text(path: &str) -> Result<String, String> {
    let path = canonical_text_file(path)?;
    std::fs::read_to_string(path).map_err(|e| format!("Cannot read text file: {e}"))
}

pub fn write_user_text(path: &str, contents: &str) -> Result<String, String> {
    if contents.len() as u64 > MAX_TEXT_BYTES {
        return Err("Updated text is larger than the 1 MB safety limit.".into());
    }
    let path = canonical_text_file(path)?;
    std::fs::write(&path, contents).map_err(|e| format!("Cannot save text file: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn canonical_text_file(path: &str) -> Result<PathBuf, String> {
    let supplied = Path::new(path);
    if !supplied.is_absolute() {
        return Err("Text file path must be absolute.".into());
    }
    let path = supplied.canonicalize().map_err(|e| format!("Text file is not accessible: {e}"))?;
    if !path.is_file() || !is_text_file(&path) {
        return Err("Only existing common text/code files can be opened for writing.".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Cannot inspect text file: {e}"))?;
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("Text file is larger than the 1 MB safety limit.".into());
    }
    Ok(path)
}

fn is_text_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    ALLOWED_TEXT_EXTENSIONS.contains(&extension.as_str())
}

fn is_code_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    CODE_EXTENSIONS.contains(&extension.as_str())
}

pub fn create_desktop_text(desktop: &Path, name: Option<&str>) -> Result<CreatedFile, String> {
    if !desktop.is_dir() {
        return Err(format!("Desktop folder does not exist: {}", desktop.display()));
    }

    let requested = name.unwrap_or("ACT 3 note").trim();
    if requested.is_empty() {
        return Err("Enter a file name.".into());
    }
    if requested.len() > 120
        || requested.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
        || requested == "."
        || requested == ".."
    {
        return Err("Use a file name without folder separators or reserved characters.".into());
    }
    let stem = if requested.to_ascii_lowercase().ends_with(".txt") {
        &requested[..requested.len() - 4]
    } else {
        requested
    };
    if stem.trim().is_empty() {
        return Err("Enter a valid file name.".into());
    }

    for suffix in 1..=999 {
        let filename = if suffix == 1 {
            format!("{stem}.txt")
        } else {
            format!("{stem} ({suffix}).txt")
        };
        let path = desktop.join(&filename);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(CreatedFile { name: filename, path: path.to_string_lossy().to_string() }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && name.is_none() => continue,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(format!("{} already exists; no file was changed.", path.display()));
            }
            Err(error) => return Err(format!("Could not create Desktop file: {error}")),
        }
    }
    Err("Could not find an unused ACT 3 note file name on the Desktop.".into())
}

pub fn create_text(root: &str, relative: &str, contents: &str, confirmed: bool) -> Result<String, String> {
    if !confirmed {
        return Err("Explicit confirmation is required before creating a file.".into());
    }
    let root = root_dir(root)?;
    if relative.trim().is_empty() || Path::new(relative).is_absolute() {
        return Err("New file path must be relative to the selected root.".into());
    }
    let candidate = root.join(relative);
    let parent = candidate.parent().ok_or_else(|| "Invalid destination folder.".to_string())?;
    let parent = parent.canonicalize().map_err(|e| format!("Destination folder is not accessible: {e}"))?;
    if !parent.starts_with(&root) {
        return Err("New file path escapes the selected search root.".into());
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&candidate)
        .and_then(|mut file| std::io::Write::write_all(&mut file, contents.as_bytes()))
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Refusing to overwrite an existing file.".to_string()
            } else {
                format!("Could not create file: {error}")
            }
        })?;
    Ok(candidate.strip_prefix(&root).unwrap_or(&candidate).to_string_lossy().to_string())
}

pub fn copy_text(contents: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
    clipboard.set_text(contents).map_err(|e| format!("Could not copy to clipboard: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_code_changes, create_text, prepare_code_proposal, read_user_text,
        write_user_text, CodeChange, ProposedCodeChange,
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    fn test_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "act3-safe-tools-{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn explicit_text_write_updates_only_existing_text_files() {
        let dir = test_dir();
        let path = dir.join("draft.txt");
        std::fs::write(&path, "old text").unwrap();

        assert_eq!(read_user_text(path.to_str().unwrap()).unwrap(), "old text");
        assert_eq!(
            write_user_text(path.to_str().unwrap(), "updated text").unwrap(),
            path.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "updated text");
        assert!(write_user_text(dir.join("missing.txt").to_str().unwrap(), "no").is_err());
        assert!(write_user_text(path.with_extension("pdf").to_str().unwrap(), "no").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn create_text_refuses_to_overwrite_existing_files() {
        let dir = test_dir();
        std::fs::write(dir.join("draft.txt"), "keep").unwrap();
        assert!(create_text(dir.to_str().unwrap(), "draft.txt", "replace", true).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("draft.txt")).unwrap(), "keep");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn code_proposals_are_confined_and_reject_stale_files_before_writing() {
        let dir = test_dir();
        std::fs::write(dir.join("main.rs"), "old").unwrap();
        let unsafe_change = prepare_code_proposal(
            dir.to_str().unwrap(),
            "escape".into(),
            vec![ProposedCodeChange {
                path: "../outside.rs".into(),
                contents: "bad".into(),
            }],
            &[],
        );
        assert!(unsafe_change.is_err());

        let changes = vec![
            CodeChange {
                path: "main.rs".into(),
                original_contents: Some("old".into()),
                contents: "updated".into(),
            },
            CodeChange {
                path: "new.rs".into(),
                original_contents: None,
                contents: "new file".into(),
            },
        ];
        std::fs::write(dir.join("new.rs"), "created outside proposal").unwrap();
        assert!(apply_code_changes(dir.to_str().unwrap(), &changes).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("main.rs")).unwrap(), "old");
        std::fs::remove_file(dir.join("new.rs")).unwrap();

        let applied = apply_code_changes(dir.to_str().unwrap(), &changes).unwrap();
        assert_eq!(applied, ["main.rs", "new.rs"]);
        assert_eq!(std::fs::read_to_string(dir.join("main.rs")).unwrap(), "updated");
        assert_eq!(std::fs::read_to_string(dir.join("new.rs")).unwrap(), "new file");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn code_proposals_cannot_replace_source_omitted_from_model_context() {
        let dir = test_dir();
        std::fs::write(dir.join("hidden.rs"), "do not replace").unwrap();
        let proposal = prepare_code_proposal(
            dir.to_str().unwrap(),
            "replace unseen file".into(),
            vec![ProposedCodeChange {
                path: "hidden.rs".into(),
                contents: "new".into(),
            }],
            &[],
        );
        assert!(proposal.is_err());
        assert_eq!(std::fs::read_to_string(dir.join("hidden.rs")).unwrap(), "do not replace");

        let accepted = prepare_code_proposal(
            dir.to_str().unwrap(),
            "replace included file".into(),
            vec![ProposedCodeChange {
                path: "hidden.rs".into(),
                contents: "new".into(),
            }],
            &["hidden.rs".into()],
        );
        assert!(accepted.is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn workspace_context_skips_generated_and_dependency_folders() {
        let dir = test_dir();
        std::fs::write(dir.join("app.rs"), "fn app() {}").unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules").join("dep.rs"), "secret dependency").unwrap();
        let files = super::workspace_files(dir.to_str().unwrap()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "app.rs");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
