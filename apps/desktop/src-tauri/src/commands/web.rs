use super::CommandResult;
use crate::state::AppState;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
#[cfg(any(test, windows, target_os = "macos"))]
#[allow(unused_imports)] // Stdio and line reading are only used where the runtime ships, and by its tests.
use std::{path::PathBuf, process::Stdio};
use tauri::State;
use thingmaker_supervisor::{DesktopError, SessionHandle};
#[cfg(any(windows, target_os = "macos"))]
use thingmaker_supervisor::security::EnvironmentProfile;
#[allow(unused_imports)]
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines}, process::{Child, ChildStdin, ChildStdout, Command}, sync::Mutex};

use thingmaker_supervisor::{
    agents::local::LocalKind,
    integrations::member_resources::WEB_SUPPORTED,
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig, SessionEvent},
};

#[cfg(any(windows, target_os = "macos"))]
mod lazy;
#[cfg(windows)]
mod process_job;

pub type Connection = Arc<Mutex<WebSession>>;
pub struct WebSession {
    command: Command,
    runtime: Option<Runtime>,
    listener: Option<tokio::task::JoinHandle<()>>,
    closed: bool,
}

impl Drop for WebSession {
    fn drop(&mut self) {
        if let Some(listener) = &self.listener { listener.abort(); }
    }
}

struct Runtime {
    #[cfg(any(windows, target_os = "macos"))]
    endpoint: (String, String),
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    seq: u64,
    browse_lease: Option<Arc<()>>,
}


// One chat owns a lent target at a time. Dropping the session frees the lease.
fn reserve_browse_tab(key: &str) -> Result<Arc<()>, String> {
    use std::{collections::HashMap, sync::{LazyLock, Mutex, Weak}};
    static TABS: LazyLock<Mutex<HashMap<String, Weak<()>>>> = LazyLock::new(Mutex::default);
    let mut tabs = TABS.lock().unwrap_or_else(|e| e.into_inner());
    tabs.retain(|_, owner| owner.strong_count() != 0);
    if tabs.contains_key(key) { return Err("This tab is already shared with another ThingMaker chat.".into()); }
    let lease = Arc::new(());
    tabs.insert(key.to_owned(), Arc::downgrade(&lease));
    Ok(lease)
}

/// The private Node.js that ships in the web runtime.
#[cfg(any(windows, target_os = "macos"))]
const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };

#[cfg(any(windows, target_os = "macos"))]
pub(super) fn installed_runtime(state: &AppState) -> Result<PathBuf, String> {
    let installed = state.resource_dir.as_ref().map(|p| p.join("web-runtime"));
    #[cfg(debug_assertions)]
    let installed = installed.filter(|p| p.join(NODE).is_file()).or_else(|| Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-web")));
    let root = installed.ok_or("The installed web runtime is missing")?;
    dunce::canonicalize(root).map_err(|_| "The web runtime is missing. Reinstall ThingMaker.".to_string())
}

impl WebSession {
    #[cfg(not(any(windows, target_os = "macos")))]
    pub async fn launch(_: &AppState, _: bool) -> Result<(Connection, Value), String> {
        Err("ThingMaker Web is available on Windows and macOS.".into())
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub async fn launch(state: &AppState, enabled: bool) -> Result<(Connection, Value), String> {
        let mut env_profile = EnvironmentProfile::trusted_local();
        if let Some(home) = &state.home { env_profile = env_profile.with_tool_paths(home); }
        let env = env_profile.resolve(std::env::vars());
        let root = installed_runtime(state)?;
        let mut command = Command::new(root.join(NODE));
        command.arg(root.join("session.mjs")).current_dir(&root).env_clear().envs(env)
            .env("THINGMAKER_BROWSE_BIN_DIR", state.data_dir.join("tools/browse"))
            .env("THINGMAKER_WEB_MCP_DIR", &root)
            .env("PLAYWRIGHT_BROWSERS_PATH", root.join("browsers"));
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(test)]
        command.env("THINGMAKER_WEB_TEST_LOOPBACK", "1");
        #[cfg(test)]
        for name in ["OPENCODE_BROWSER_HOME", "OPENCODE_BROWSER_PORT"] {
            if let Some(value) = std::env::var_os(name) {
                if name == "OPENCODE_BROWSER_HOME" { command.env("THINGMAKER_BROWSE_BIN_DIR", PathBuf::from(&value).join("bin")); }
                command.env(name, value);
            }
        }
        command.env("THINGMAKER_WEB_ENABLED", if enabled { "1" } else { "0" })
            .env("WEB_SCOUT_ENV_FILE", "none").env("WEB_SCOUT_LLM_PROVIDER", "none").env("WEB_SCOUT_BROWSER_PREWARM", "false")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).kill_on_drop(true);
        let session = Arc::new(Mutex::new(Self { command, runtime: None, listener: None, closed: false }));
        let entry = lazy::listen(&session, &root).await?;
        Ok((session, entry))
    }

    async fn runtime(&mut self) -> Result<&mut Runtime, String> {
        if self.closed { return Err("The web session closed. Reopen the session to reconnect.".into()); }
        if self.runtime.is_none() {
            self.runtime = Some(Runtime::start(&mut self.command).await?);
        }
        Ok(self.runtime.as_mut().expect("runtime just initialized"))
    }

    pub(crate) async fn close(&mut self) {
        self.closed = true;
        if let Some(listener) = self.listener.take() { listener.abort(); }
        if let Some(mut runtime) = self.runtime.take() {
            // EOF asks the control script to close Chromium and its MCP client.
            drop(runtime.input);
            if !matches!(tokio::time::timeout(Duration::from_secs(3), runtime.child.wait()).await, Ok(Ok(_))) {
                let _ = runtime.child.kill().await;
            }
        }
    }

    async fn control(&mut self, action: Value) -> Result<Value, String> {
        self.runtime().await?.control(action).await
    }
}

impl Runtime {
    #[cfg(not(any(windows, target_os = "macos")))]
    async fn start(_: &mut Command) -> Result<Self, String> {
        Err("ThingMaker Web is available on Windows and macOS.".into())
    }

    #[cfg(any(windows, target_os = "macos"))]
    async fn start(command: &mut Command) -> Result<Self, String> {
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        // Windows needs a job to stop the runtime's descendants when the desktop
        // exits. Elsewhere the runtime closes Chromium and exits once its input
        // pipe closes, which a desktop exit or crash does.
        #[cfg(windows)]
        process_job::track(&child)?;
        let input = child.stdin.take().ok_or("Missing web control pipe")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("Missing web reply pipe")?).lines();
        let line = tokio::time::timeout(Duration::from_secs(10), output.next_line()).await.map_err(|_| "web-mcp startup timed out")?
            .map_err(|e| e.to_string())?.ok_or("The web runtime exited during startup.")?;
        let ready: Value = serde_json::from_str(&line).map_err(|_| "Invalid web-mcp startup reply")?;
        let port = ready["port"].as_u64().ok_or("Missing web-mcp port")?;
        let token = ready["token"].as_str().ok_or("Missing web-mcp credential")?;
        Ok(Self { endpoint: (format!("http://127.0.0.1:{port}/mcp"), format!("Bearer {token}")),
            child, input, output, seq: 0, browse_lease: None })
    }

    async fn control(&mut self, action: Value) -> Result<Value, String> {
        let kind = action["kind"].as_str().unwrap_or_default();
        let pending = if kind == "attachBrowse" {
            if self.browse_lease.is_some() { return Err("Unshare the current tab first.".into()); }
            Some(reserve_browse_tab(action["key"].as_str().ok_or("Missing tab")?)?)
        } else { None };
        self.seq += 1;
        let mut request = serde_json::to_vec(&json!({"id":self.seq,"action":action})).map_err(|e| e.to_string())?;
        request.push(b'\n');
        self.input.write_all(&request).await.map_err(|e| e.to_string())?;
        while let Some(line) = self.output.next_line().await.map_err(|e| e.to_string())? {
            let mut reply: Value = serde_json::from_str(&line).map_err(|_| "Invalid web runtime reply")?;
            if reply["id"].as_u64() != Some(self.seq) { continue; }
            if let Some(error) = reply["error"].as_str() {
                return Err(error.to_owned());
            }
            if let Some(lease) = pending { self.browse_lease = Some(lease); }
            if kind == "unshare" || reply["value"]["chrome"] == "disconnected" { self.browse_lease = None; }
            return Ok(reply["value"].take());
        }
        Err("The web session closed. Reopen the session to reconnect.".into())
    }
}

pub async fn prepare(state: &AppState, config: &mut SessionActorConfig) -> Option<Result<Connection, String>> {
    if !WEB_SUPPORTED { return None; }
    // A local agent reaches the internet only with an explicit Web selection.
    let instructions = match &mut config.launch {
        AgentLaunch::Claude(options) if ((options.local.is_none() && options.resources.is_none()) || config.builtin_web)
            && options.local.as_ref().is_none_or(|l| l.kind == LocalKind::Agent) => &mut options.append_system_prompt,
        AgentLaunch::Codex(options) if (!options.local && options.resources.is_none()) || config.builtin_web => &mut options.developer_instructions,
        _ => return None,
    };
    config.builtin_web = true;
    Some(WebSession::launch(state, true).await.map(|(session, entry)| {
        config.mcp_servers.push(entry);
        instructions.get_or_insert_with(String::new).push_str("\nUse thingmaker-web web_search and web_read for background research. When text is insufficient for a chart or diagram, request web_read with screenshot=true. Use web_open, web_page and web_act for the shared Web tab. The user can edit the same page at any time. If the page changes unexpectedly, inspect web_page and continue from its current state.");
        session
    }))
}


pub fn attach(state: &AppState, actor: &SessionActor, web: Option<Result<Connection, String>>) {
    let Some(entry) = web else { return };
    if let Ok(connection) = &entry {
        let weak = Arc::downgrade(connection);
        let mut events = actor.subscribe();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                if matches!(event.payload, SessionEvent::Exited(_)) { break; }
            }
            if let Some(live) = weak.upgrade() {
                let mut session = live.lock().await;
                session.close().await;
            }
        });
    }
    state.web_sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(actor.handle().id.clone(), entry);
}

#[tauri::command]
pub async fn web_browser_open(state: State<'_, AppState>) -> CommandResult<SessionHandle> {
    let (connection, _) = WebSession::launch(&state, true).await.map_err(DesktopError::io)?;
    let id = format!("browser-{}", uuid::Uuid::new_v4());
    state.web_sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), Ok(connection));
    Ok(SessionHandle { id, attachment_generation: thingmaker_supervisor::DecimalId(1) })
}

#[tauri::command]
pub async fn web_control(handle: SessionHandle, action: Value, state: State<'_, AppState>) -> CommandResult<Value> {
    if handle.id.starts_with("browser-") {
        if action["kind"] == "close" {
            let entry = state.web_sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&handle.id);
            if let Some(Ok(session)) = entry { session.lock().await.close().await; }
            return Ok(Value::Null);
        }
    } else {
        super::session::actor_for(&state, &handle)?;
    }
    let session = state.web_sessions.lock().unwrap_or_else(|e| e.into_inner()).get(&handle.id).cloned()
        .ok_or_else(|| DesktopError::not_ready("Web requires a Claude Code, Codex, or local agent session."))?
        .map_err(DesktopError::not_ready)?;
    if action.to_string().len() > 32768 { return Err(DesktopError::limit_exceeded("Web input too large")); }
    let mut session = session.lock().await;
    match tokio::time::timeout(Duration::from_secs(65), session.control(action)).await {
        Ok(result) => result.map_err(DesktopError::io),
        Err(_) => {
            session.close().await;
            Err(DesktopError::not_ready("Web request timed out. Reopen the session."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use thingmaker_supervisor::{
        acp::LaunchTarget,
        agents::{PermissionStance, codex::CodexLaunchOptions},
        supervisor::{AgentLaunch, SessionActor, SessionActorConfig, SessionEvent, TurnEffect, TurnPhase},
    };

    #[tokio::test]
    async fn inherited_local_codex_resources_leave_web_offline() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::initialize(temp.path(), None).unwrap();
        let program = temp.path().join("codex.exe");
        let mut options = CodexLaunchOptions::new(temp.path(), program.clone());
        options.local = true;
        let mut config = SessionActorConfig::new(LaunchTarget::executable(program), AgentLaunch::Codex(options));
        assert!(prepare(&state, &mut config).await.is_none());
        assert!(config.mcp_servers.is_empty());
    }

    #[test]
    fn dropping_a_pending_attachment_releases_its_tab() {
        let key = "pending-attachment";
        let pending = reserve_browse_tab(key).unwrap();
        assert!(reserve_browse_tab(key).is_err());
        drop(pending);
        assert!(reserve_browse_tab(key).is_ok());
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[tokio::test]
    #[ignore = "requires the staged web runtime"]
    async fn the_panel_renders_a_page_in_the_bundled_chromium() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::initialize(temp.path(), None).unwrap();
        let app = axum::Router::new().route("/", axum::routing::get(|| async { axum::response::Html("<h1>Rendered</h1>") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (web, _) = WebSession::launch(&state, true).await.unwrap();
        let frame = web.lock().await.control(json!({"kind":"open","url":origin})).await.unwrap();
        assert_eq!(frame["url"], format!("{origin}/"));
        assert!(frame["image"].is_string());
        web.lock().await.close().await;
        fixture.abort();
    }

    #[tokio::test]
    #[ignore = "requires a local Ollama model, Codex and the ThingMaker web runtime"]
    async fn local_codex_consults_javascript_without_losing_the_draft() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let state = AppState::initialize(root, None).unwrap();
        check_live_read(&state, local_codex_config(root)).await;
    }

    #[tokio::test]
    #[ignore = "requires a tool-capable Ollama model, Codex, staged web runtime and internet"]
    async fn local_agent_web_requires_selection() {
        use thingmaker_supervisor::{acp::SessionUpdate, agents::codex::launch::CodexResources};

        for private in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let state = AppState::initialize(temp.path(), None).unwrap();
            let mut config = local_codex_config(temp.path());
            let AgentLaunch::Codex(options) = &mut config.launch else { unreachable!() };
            std::fs::create_dir(temp.path().join("tmp")).unwrap();
            options.local = true;
            #[cfg(windows)]
            {
                let launcher = std::env::var_os("THINGMAKER_WEB_TEST_DESKTOP").expect("ThingMaker executable");
                thingmaker_supervisor::agents::local::sandbox::prepare(temp.path(), temp.path(), &[options.program.parent().unwrap().into()]).unwrap();
                config.target = LaunchTarget { executable: launcher.into(), prefix_args: vec![thingmaker_appcontainer::LAUNCH_ARG.into(), options.program.to_string_lossy().into_owned()] };
            }
            config.environment = config.environment.with_program_dir(&options.program);
            options.resources = Some(CodexResources { skills: vec![], mcps: Default::default() });
            config.builtin_web = !private;
            let web = prepare(&state, &mut config).await.transpose().unwrap();
            assert_eq!(web.is_none(), private);
            if let Some(connection) = &web {
                let frame = connection.lock().await.control(json!({"kind":"frame"})).await.unwrap();
                assert_eq!(frame["enabled"], true);
            }
            let actor = SessionActor::open(config).await.unwrap();
            let mut events = actor.subscribe();
            let mut completed = std::collections::BTreeSet::new();
            actor.submit_text("permission-check", "Busca en la documentación oficial de Playwright para JavaScript cómo instalar Chromium con la CLI. Usa exclusivamente thingmaker-web: web_search con site playwright.dev y luego web_read. Dame el comando y cita la URL que has leído. Si no dispones de esas herramientas, indícalo.").await.unwrap();
            tokio::time::timeout(Duration::from_secs(180), async {
                loop {
                    let event = events.recv().await.unwrap();
                    match &event.payload {
                        SessionEvent::Update(SessionUpdate::ToolCallUpdate(tool)) if tool.status.as_deref() == Some("completed") => {
                            if let Some(name) = &tool.name { completed.insert(name.clone()); }
                        }
                        SessionEvent::Turn(TurnEffect::Settled { phase, .. }) => {
                            assert_eq!(*phase, TurnPhase::Succeeded);
                            break;
                        }
                        _ => {}
                    }
                }
            }).await.unwrap();
            actor.stop().await.unwrap();
            assert_eq!(completed.contains("web_search"), !private);
            assert_eq!(completed.contains("web_read"), !private);
        }
    }
    fn local_codex_config(root: &std::path::Path) -> SessionActorConfig {
        let program = PathBuf::from(std::env::var_os("THINGMAKER_CODEX").expect("Codex executable"));
        let account = root.join("codex");
        std::fs::create_dir(&account).unwrap();
        std::fs::write(account.join("config.toml"), "model_provider = \"ollama\"\n").unwrap();
        let mut options = CodexLaunchOptions::new(root, program.clone());
        options.codex_home = Some(account);
        options.model = Some(std::env::var("THINGMAKER_WEB_TEST_MODEL").expect("Ollama model"));
        options.permission_mode = PermissionStance::AcceptEdits;
        SessionActorConfig::new(LaunchTarget::executable(program), AgentLaunch::Codex(options))
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires Chrome for Testing, Codex, a local Ollama model and the staged web runtime"]
    async fn chrome_extension_returns_the_same_tab_to_a_live_agent() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::initialize(temp.path(), None).unwrap();
        let mut config = local_codex_config(temp.path());
        let web = prepare(&state, &mut config).await.unwrap().unwrap();
        let server = config.mcp_servers.last().unwrap().clone();
        let frame = web.lock().await.control(json!({"kind":"pair"})).await.unwrap();
        let actor = SessionActor::open(config).await.unwrap();
        attach(&state, &actor, Some(Ok(web.clone())));
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut test = Command::new(root.join("apps/desktop/dist-web/node.exe"))
            .arg("scripts/test-chrome-tab.mjs").current_dir(root).kill_on_drop(true)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut input = test.stdin.take().unwrap();
        let mut output = BufReader::new(test.stdout.take().unwrap()).lines();
        let settings = json!({"code":frame["pairingCode"], "relay":frame["relayAddress"], "server":server});
        input.write_all(format!("{settings}\n").as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(200), async {
            async fn handle_ui(web: &Connection, input: &mut ChildStdin, line: &str) {
                let action = serde_json::from_str(line).unwrap();
                let frame = web.lock().await.control(action).await.unwrap();
                input.write_all(format!("{frame}\n").as_bytes()).await.unwrap();
            }
            loop {
                let line = output.next_line().await.unwrap().expect("Chrome test exited before lending the tab");
                if line == "shared" { break; }
                handle_ui(&web, &mut input, &line).await;
            }
            let mut events = actor.subscribe();
            actor.submit_text("chrome-test", "Inspect the shared tab with web_page, select Books using web_act with role combobox, name Category and value Books, then finish this turn.").await.unwrap();
            input.write_all(b"start\n").await.unwrap();
            loop {
                let line = output.next_line().await.unwrap().expect("Chrome test exited before completing");
                if line == "Games opened" { break; }
                if line == "clicked" {
                    while !matches!(events.recv().await.unwrap().payload, SessionEvent::Turn(TurnEffect::Settled { .. })) {}
                    input.write_all(b"revoke\n").await.unwrap();
                    continue;
                }
                if line == "edited" {
                    while !matches!(events.recv().await.unwrap().payload, SessionEvent::Turn(TurnEffect::Settled { .. })) {}
                    actor.submit_text("chrome-edited", "Use thingmaker-web web_page now. Click the visible Open button for the currently selected category using web_act action click and its current snapshot ref.").await.unwrap();
                    continue;
                }
                handle_ui(&web, &mut input, &line).await;
            }
            drop(input);
            assert!(test.wait().await.unwrap().success());
        }).await.unwrap();
        actor.stop().await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires the installed ThingMaker AppContainer, its loopback permission and a tool-capable Ollama model"]
    async fn local_claude_reads_a_source_with_selected_web_access() {
        use thingmaker_supervisor::agents::{Provider, claude::launch::ClaudeLaunchOptions, local::LocalTarget};
        let profile = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap()).join("Packages/ThingMaker.LocalModels/AC");
        let scratch = tempfile::tempdir_in(profile).unwrap();
        let root = scratch.path();
        let state = AppState::initialize(root, None).unwrap();
        let adapter = state.resolve_provider(Provider::Claude).unwrap();
        let model = std::env::var("THINGMAKER_WEB_TEST_MODEL").unwrap();
        let script = std::path::Path::new(&adapter.prefix_args[0]);
        thingmaker_supervisor::agents::local::sandbox::prepare(root, root, &[
            adapter.program.parent().unwrap().into(),
            super::super::session::adapter_package_root(script).unwrap(),
        ]).unwrap();
        let mut options = ClaudeLaunchOptions::new(root, adapter.program.clone(), adapter.prefix_args.clone());
        options.local = Some(LocalTarget { kind: LocalKind::Agent, model: model.clone(), served: model, window: 32768, home: root.into() });
        options.permission_mode = PermissionStance::AcceptEdits;
        let launcher = PathBuf::from(std::env::var_os("THINGMAKER_WEB_TEST_DESKTOP").expect("ThingMaker executable"));
        let target = LaunchTarget { executable: launcher, prefix_args: vec![thingmaker_appcontainer::LAUNCH_ARG.into(), adapter.program.to_string_lossy().into_owned()] };
        let mut config = SessionActorConfig::new(target, AgentLaunch::Claude(options));
        config.environment = config.environment.with_program_dir(&adapter.program);
        check_live_read(&state, config).await;
    }

    async fn check_live_read(state: &AppState, mut config: SessionActorConfig) {
        config.builtin_web = true;
        let web = prepare(state, &mut config).await.unwrap().unwrap();
        let frame = web.lock().await.control(json!({"kind":"frame"})).await.unwrap();
        assert_eq!(frame["enabled"], true);
        // Random labels and bar heights exist only in canvas pixels in the tool result.
        let labels: Vec<_> = (0..3).map(|_| uuid::Uuid::new_v4().simple().to_string()[..4].to_uppercase()).collect();
        let tallest = uuid::Uuid::new_v4().as_bytes()[0] as usize % labels.len();
        let code = &labels[tallest];
        let draft = uuid::Uuid::new_v4().simple().to_string();
        let source = format!(r#"<h1>Quarterly totals</h1><canvas width="800" height="420"></canvas>
            <script>const ctx = document.querySelector('canvas').getContext('2d');
            const labels = {labels}; ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'center';
            labels.forEach((label, i) => {{
                const height = i === {tallest} ? 300 : 70 + i * 30;
                const x = 130 + i * 240;
                ctx.fillStyle = 'navy'; ctx.fillRect(x - 70, 330 - height, 140, height);
                ctx.fillStyle = 'black'; ctx.fillText(label, x, 385);
            }});</script>"#, labels = json!(labels));
        let app = axum::Router::new()
            .route("/form", axum::routing::get(|| async { axum::response::Html(
                r#"<form action="/saved"><label>Draft<input name="draft"></label><label>Reference<input name="reference"></label><button>Save</button></form>"#
            ) }))
            .route("/source", axum::routing::get(move || async move { axum::response::Html(source) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        {
            let mut session = web.lock().await;
            let frame = session.control(json!({"kind":"open","url":format!("{origin}/form")})).await.unwrap();
            let (revision, navigation) = (&frame["revision"], &frame["navigation"]);
            session.control(json!({"kind":"key","key":"Tab","revision":revision,"navigation":navigation})).await.unwrap();
            session.control(json!({"kind":"text","text":draft,"revision":revision,"navigation":navigation})).await.unwrap();
        }
        let actor = SessionActor::open(config).await.unwrap();
        let mut events = actor.subscribe();
        actor.submit_text("web-test", &format!(
            "Use only thingmaker-web. Inspect my current form using web_page. Read the bar chart at {origin}/source using web_read with screenshot=true. Enter the exact label beneath the tallest bar into Reference using web_act and click Save. Keep the existing draft."
        )).await.unwrap();
        tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                if let SessionEvent::Turn(TurnEffect::Settled { phase, .. }) = &events.recv().await.unwrap().payload {
                    assert_eq!(*phase, TurnPhase::Succeeded);
                    break;
                }
            }
        }).await.unwrap();
        let frame = web.lock().await.control(json!({"kind":"frame"})).await.unwrap();
        assert_eq!(frame["url"], format!("{origin}/saved?draft={draft}&reference={code}"));
        fixture.abort();
        assert!(frame["image"].is_string());
        actor.stop().await.unwrap();
    }
}
