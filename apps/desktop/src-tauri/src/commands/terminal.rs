//! Interactive terminals (TERM-01..03).
//!
//! Creation is explicit and limited to trusted workspaces. The shell runs
//! under the same documented environment profile as Kit (ambient secrets are
//! not inherited unless allowlisted). Output is streamed as base64 chunks;
//! scrollback is replayed first so a reconnecting view is complete.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, ipc::Channel};
use thingmaker_supervisor::{
    DesktopError,
    security::EnvironmentProfile,
    storage::workspaces::TrustState,
    terminal::{TerminalEvent, TerminalInfo, TerminalSpawn},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequest {
    pub workspace_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub info: TerminalInfo,
    pub workspace_id: String,
    pub environment_note: &'static str,
}

fn default_shell() -> PathBuf {
    if cfg!(windows) {
        return std::env::var_os("COMSPEC").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
    }
    if let Some(shell) = std::env::var_os("SHELL")
        && !shell.is_empty()
        && PathBuf::from(&shell).is_file()
    {
        return PathBuf::from(shell);
    }
    if cfg!(target_os = "macos") { PathBuf::from("/bin/zsh") } else { PathBuf::from("/bin/sh") }
}

/// The folder the shell starts in. On Windows, Rust's canonical `\\?\D:\…`
/// paths read to CMD as UNC, and it silently starts in `C:\Windows` instead,
/// so the plain drive path is passed; network folders are refused.
fn shell_cwd(root: &str) -> CommandResult<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(path) = root.strip_prefix("\\\\?\\") {
            if path.starts_with("UNC\\") {
                return Err(DesktopError::unsupported("CMD terminals require a local project folder"));
            }
            return Ok(PathBuf::from(path));
        }
        if root.starts_with("\\\\") {
            return Err(DesktopError::unsupported("CMD terminals require a local project folder"));
        }
    }
    Ok(PathBuf::from(root))
}

#[cfg(all(test, windows))]
mod shell_cwd_tests {
    use super::*;
    #[test]
    fn cmd_uses_the_project_drive_path_and_never_falls_back_from_unc() {
        assert_eq!(shell_cwd(r"\\?\D:\repos\project").unwrap(), PathBuf::from(r"D:\repos\project"));
        assert_eq!(shell_cwd(r"D:\repos\project").unwrap(), PathBuf::from(r"D:\repos\project"));
        assert!(shell_cwd(r"\\?\UNC\server\project").is_err());
        assert!(shell_cwd(r"\\server\project").is_err());
    }
}

#[tauri::command]
pub fn terminal_open(request: TerminalOpenRequest, state: State<'_, AppState>) -> CommandResult<TerminalOpened> {
    let record = state
        .with_storage(|s| s.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    if record.trust_state != TrustState::TrustedLocal {
        return Err(DesktopError::untrusted("Terminals run arbitrary commands with your account; trust the workspace (trusted local) first."));
    }
    let mut profile = EnvironmentProfile::trusted_local();
    for (name, value) in super::runtime_env::resolve_for_launch(&state).0 {
        profile = profile.with_set(name, value);
    }
    let env: Vec<(String, String)> = profile.resolve(std::env::vars()).into_iter().collect();
    let shell = default_shell();
    let terminal = state.terminals.open(TerminalSpawn {
        cwd: shell_cwd(&record.canonical_root)?,
        program: shell,
        args: if cfg!(windows) { vec!["/D".into()] } else { vec!["-l".into()] },
        env,
        cols: request.cols,
        rows: request.rows,
    })?;
    state.terminal_workspaces.lock().unwrap_or_else(|p| p.into_inner()).insert(terminal.id.clone(), record.id.clone());
    Ok(TerminalOpened {
        info: terminal.info(),
        workspace_id: record.id,
        environment_note: "Shell started with the documented environment profile: PATH, locale and KIT_* variables are inherited, plus the runtime variables you added in Integrations; other ambient credentials are not.",
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListEntry {
    pub info: TerminalInfo,
    pub workspace_id: Option<String>,
}

#[tauri::command]
pub fn terminal_list(state: State<'_, AppState>) -> Vec<TerminalListEntry> {
    let map = state.terminal_workspaces.lock().unwrap_or_else(|p| p.into_inner());
    state
        .terminals
        .list()
        .into_iter()
        .map(|info| TerminalListEntry { workspace_id: map.get(&info.id).cloned(), info })
        .collect()
}

/// Streams scrollback (as one output chunk) followed by live events.
#[tauri::command]
pub fn terminal_subscribe(id: String, on_event: Channel<TerminalEvent>, state: State<'_, AppState>) -> CommandResult<()> {
    let terminal = state.terminals.get(&id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
    let mut receiver = terminal.subscribe();
    let scrollback = terminal.scrollback();
    if !scrollback.is_empty() {
        let _ = on_event.send(TerminalEvent::Output { data_base64: encode_base64(&scrollback) });
    }
    if terminal.is_exited() {
        let _ = on_event.send(TerminalEvent::Exit { code: terminal.info().exit_code });
        return Ok(());
    }
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if on_event.send((*event).clone()).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
    Ok(())
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteRequest {
    pub id: String,
    /// UTF-8 text from the terminal view (keystrokes or an approved paste).
    pub text: String,
}

#[tauri::command]
pub fn terminal_write(request: TerminalWriteRequest, state: State<'_, AppState>) -> CommandResult<()> {
    write_terminal(&state, &request.id, request.text.as_bytes())
}

fn write_terminal(state: &AppState, id: &str, bytes: &[u8]) -> CommandResult<()> {
    let terminal = state.terminals.get(id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
    let folder = state.auth_terminal_profiles.lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned();
    if let Some(folder) = folder {
        // A person may leave the browser or setup wizard open for a long time.
        // Refresh file-only auth BEFORE forwarding any code or confirmation.
        thingmaker_supervisor::agents::gemini::launch::prepare_file_auth(&folder).map_err(DesktopError::io)?;
    }
    terminal.write(bytes)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub fn terminal_resize(request: TerminalResizeRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let terminal = state.terminals.get(&request.id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
    terminal.resize(request.cols, request.rows)
}

#[tauri::command]
pub fn terminal_close(id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.auth_terminal_profiles.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    state.terminal_workspaces.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    state.terminals.close(&id)
}

/// Scrollback as lossy text for export. The renderer shows a redaction preview
/// before the user saves it.
#[tauri::command]
pub fn terminal_export(id: String, state: State<'_, AppState>) -> CommandResult<String> {
    state.terminals.export(&id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextRequest {
    pub suggested_name: String,
    pub content: String,
}

/// Saves text through the native save dialog (an explicit, mediated export).
#[tauri::command]
pub async fn save_text_file(request: SaveTextRequest, app: AppHandle) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    if request.content.len() > 64 * 1024 * 1024 {
        return Err(DesktopError::limit_exceeded("export exceeds 64 MiB"));
    }
    let name: String = request.suggested_name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(if name.is_empty() { "export.txt" } else { &name }).blocking_save_file())
        .await
        .map_err(|e| DesktopError::io(e.to_string()))?;
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| DesktopError::io(e.to_string()))?;
    std::fs::write(&path, request.content.as_bytes()).map_err(|e| DesktopError::io(e.to_string()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    #[test]
    fn authentication_input_refreshes_an_expired_private_backend_before_forwarding() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(directory.path(), None).unwrap();
        let folder = directory.path().join("profile");
        thingmaker_supervisor::agents::gemini::launch::prepare_file_auth(&folder).unwrap();
        let marker = folder.join(".gemini/antigravity-cli/cache/antigravity-keyring-unavailable");
        std::fs::OpenOptions::new().write(true).open(&marker).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH)).unwrap();
        let terminal = state.terminals.open_private(TerminalSpawn {
            cwd: directory.path().into(), program: if cfg!(windows) { "cmd.exe".into() } else { "/bin/cat".into() },
            args: if cfg!(windows) { vec!["/D".into(), "/Q".into()] } else { vec![] },
            env: EnvironmentProfile::trusted_local().resolve(std::env::vars()).into_iter().collect(), cols: 80, rows: 24,
        }).unwrap();
        state.auth_terminal_profiles.lock().unwrap().insert(terminal.id.clone(), folder);
        let outcome = write_terminal(&state, &terminal.id, b"test-input\n");
        state.terminals.close_all();
        outcome.unwrap();
        assert!(marker.metadata().unwrap().modified().unwrap() > std::time::SystemTime::now() - std::time::Duration::from_secs(5));
    }
}
