use std::path::{Path, PathBuf};
use serde::Serialize;

const MAX_TEXT_BYTES: u64 = 1_000_000;
const MAX_RESULTS: usize = 100;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub size: u64,
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

pub fn read_text(root: &str, relative: &str) -> Result<String, String> {
    let root = root_dir(root)?;
    let path = confined_path(&root, relative)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Cannot inspect file: {e}"))?;
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("Text file is larger than the 1 MB safety limit.".into());
    }
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let allowed = ["txt", "md", "markdown", "json", "js", "ts", "tsx", "jsx", "css", "html", "rs", "toml", "yaml", "yml", "csv", "log"];
    if !allowed.contains(&extension.as_str()) {
        return Err("Only common text/code file types can be read.".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("Cannot read text file: {e}"))
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
    if candidate.exists() {
        return Err("Refusing to overwrite an existing file.".into());
    }
    let parent = candidate.parent().ok_or_else(|| "Invalid destination folder.".to_string())?;
    let parent = parent.canonicalize().map_err(|e| format!("Destination folder is not accessible: {e}"))?;
    if !parent.starts_with(&root) {
        return Err("New file path escapes the selected search root.".into());
    }
    std::fs::write(&candidate, contents).map_err(|e| format!("Could not create file: {e}"))?;
    Ok(candidate.strip_prefix(&root).unwrap_or(&candidate).to_string_lossy().to_string())
}

pub fn copy_text(contents: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
    clipboard.set_text(contents).map_err(|e| format!("Could not copy to clipboard: {e}"))
}
