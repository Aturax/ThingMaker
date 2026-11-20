//! A Claude artifact shown inside the main window.
//!
//! claude.ai refuses to load in a frame, so the page lives in a native child
//! webview that the interface positions over its artifact panel. The page is
//! remote content: it has no capability, so Tauri rejects every command it
//! might send, and it can only reach web addresses.
use super::CommandResult;
use crate::state::AppState;
use serde::Deserialize;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
    webview::{NewWindowResponse, WebviewBuilder},
};
use thingmaker_supervisor::DesktopError;

const LABEL: &str = "artifact";

/// The view's own cookie store on macOS, so its claude.ai sign-in outlives a
/// restart and stays apart from the app's own pages.
#[cfg(target_os = "macos")]
const STORE: [u8; 16] = *b"thingmaker.artif";

/// Where the panel is, in CSS pixels from the window's top-left corner.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn checked(self) -> Result<Self, DesktopError> {
        let sane = [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite() && (0.0..=20000.0).contains(v));
        if !sane || self.width < 1.0 || self.height < 1.0 {
            return Err(DesktopError::unsupported("The artifact panel has no room."));
        }
        Ok(self)
    }
}

/// Only a claude.ai artifact page is opened here; any other link goes to the browser.
fn artifact_url(url: &str) -> Result<Url, DesktopError> {
    let refused = || DesktopError::unsupported("Only claude.ai artifact links open in the artifact panel.");
    let parsed = Url::parse(url.trim()).map_err(|_| refused())?;
    let path = parsed.path();
    let artifact = path.starts_with("/artifact/") || path.starts_with("/code/artifact/");
    if parsed.scheme() != "https" || parsed.host_str() != Some("claude.ai") || !artifact || url.len() > 4096 {
        return Err(refused());
    }
    Ok(parsed)
}

/// Sign-in pages may open their own window; the app's own address never loads here.
fn sign_in_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    url.scheme() == "https"
        && (["claude.ai", "accounts.google.com", "appleid.apple.com"].contains(&host)
            || host.ends_with(".claude.ai")
            || host.ends_with(".anthropic.com"))
}

fn place(view: &tauri::Webview, bounds: Bounds) -> Result<(), DesktopError> {
    view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| DesktopError::io(e.to_string()))?;
    view.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|e| DesktopError::io(e.to_string()))
}

/// Shows the artifact in the panel, creating the view the first time.
#[tauri::command]
pub async fn artifact_view_show(url: String, bounds: Bounds, app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let url = artifact_url(&url)?;
    let bounds = bounds.checked()?;
    if let Some(view) = app.get_webview(LABEL) {
        place(&view, bounds)?;
        if view.url().map(|current| current != url).unwrap_or(true) {
            view.navigate(url).map_err(|e| DesktopError::io(e.to_string()))?;
        }
        return view.show().map_err(|e| DesktopError::io(e.to_string()));
    }
    let window = app.get_window("main").ok_or_else(|| DesktopError::not_ready("The main window is not open."))?;
    let opener = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .on_navigation(|target| {
            // The hosts a sign-in passes through, for diagnosing one that fails.
            tracing::info!(host = target.host_str().unwrap_or_default(), scheme = target.scheme(), "artifact view navigation");
            // The app's own pages (tauri:, or http://tauri.localhost on Windows) never load here.
            matches!(target.scheme(), "https" | "about" | "blob" | "data")
        })
        .on_new_window(move |target, _features| {
            tracing::info!(host = target.host_str().unwrap_or_default(), "artifact view asked for a new window");
            if sign_in_host(&target) {
                return NewWindowResponse::Allow;
            }
            if target.scheme() == "https" {
                use tauri_plugin_opener::OpenerExt;
                let _ = opener.opener().open_url(target.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        });
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(STORE);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.data_directory(state.data_dir.join("artifact-view"));
    #[cfg(target_os = "macos")]
    let _ = &state;
    window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| DesktopError::io(e.to_string()))?;
    Ok(())
}

/// Follows the panel as it moves or changes size.
#[tauri::command]
pub async fn artifact_view_bounds(bounds: Bounds, app: AppHandle) -> CommandResult<()> {
    match app.get_webview(LABEL) {
        Some(view) => place(&view, bounds.checked()?),
        None => Ok(()),
    }
}

/// Takes the view off screen. It keeps its page and sign-in for the next artifact.
#[tauri::command]
pub async fn artifact_view_hide(app: AppHandle) -> CommandResult<()> {
    match app.get_webview(LABEL) {
        Some(view) => view.hide().map_err(|e| DesktopError::io(e.to_string())),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_artifact_pages_open_in_the_panel() {
        assert!(artifact_url("https://claude.ai/code/artifact/0b1c2d3e-aaaa").is_ok());
        assert!(artifact_url("https://claude.ai/artifact/abc123").is_ok());
        for refused in [
            "http://claude.ai/artifact/abc",
            "https://claude.ai/settings",
            "https://claude.ai.evil.example/artifact/abc",
            "https://evil.example/code/artifact/abc",
            "tauri://localhost/artifact/abc",
        ] {
            assert!(artifact_url(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn only_sign_in_hosts_may_open_a_window() {
        let url = |value: &str| Url::parse(value).unwrap();
        assert!(sign_in_host(&url("https://accounts.google.com/o/oauth2/auth")));
        assert!(sign_in_host(&url("https://claude.ai/login")));
        assert!(!sign_in_host(&url("https://example.com/")));
        assert!(!sign_in_host(&url("http://claude.ai/login")));
        assert!(!sign_in_host(&url("https://notclaude.ai/")));
    }
}
