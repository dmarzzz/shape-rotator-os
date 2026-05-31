//! swf-node supervisor — Rust port of apps/os/swf-node.js.
//!
//! Spawns + supervises the bundled `swf-node` daemon (a PyInstaller binary on
//! :7777), with the same state machine, external-squatter probe, agent-token
//! persistence, restart cap, and SIGTERM→SIGKILL shutdown as the Electron
//! version. Status changes are emitted as `swf-node://status` events.

use base64::Engine;
use rand::RngCore;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const PORT: u16 = 7777;
const RESTART_LIMIT: u32 = 3;
const RESTART_BACKOFF_MS: u64 = 2000;
const SIGTERM_GRACE_MS: u64 = 3000;
const PROBE_TIMEOUT_MS: u64 = 1500;
const RUNNING_GRACE_MS: u64 = 300;
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SwfState {
    Idle,
    Starting,
    Running,
    Crashed,
    Unsupported,
    ExternalSquatter,
}

impl SwfState {
    pub fn as_str(self) -> &'static str {
        match self {
            SwfState::Idle => "idle",
            SwfState::Starting => "starting",
            SwfState::Running => "running",
            SwfState::Crashed => "crashed",
            SwfState::Unsupported => "unsupported",
            SwfState::ExternalSquatter => "external_squatter",
        }
    }
}

#[derive(Default)]
struct Inner {
    app: Option<AppHandle>,
    state: StateField,
    generation: u64,
    child_pid: Option<u32>,
    binary_path: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    log_path: Option<PathBuf>,
    cohort_keys_path: Option<PathBuf>,
    restart_count: u32,
    expect_quit: bool,
    agent_token: Option<String>,
    external_daemon: Option<Value>,
    quit_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

// Wrapper so we can derive Default (SwfState has no Default).
struct StateField(SwfState);
impl Default for StateField {
    fn default() -> Self {
        StateField(SwfState::Idle)
    }
}

type Shared = Arc<Mutex<Inner>>;

/// Handle stored in AppState.
#[derive(Clone)]
pub struct SwfNode {
    inner: Shared,
}

impl Default for SwfNode {
    fn default() -> Self {
        Self::new()
    }
}

impl SwfNode {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    pub fn status(&self) -> String {
        self.inner.lock().unwrap().state.0.as_str().to_string()
    }

    pub fn agent_token(&self) -> Option<String> {
        self.inner.lock().unwrap().agent_token.clone()
    }

    pub fn external_info(&self) -> Option<Value> {
        self.inner.lock().unwrap().external_daemon.clone()
    }

    /// Begin supervision (called once from setup). Fire-and-forget.
    pub fn start(&self, app: AppHandle) {
        {
            let mut g = self.inner.lock().unwrap();
            if g.state.0 != SwfState::Idle {
                return;
            }
            g.app = Some(app);
        }
        let shared = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            begin(shared).await;
        });
    }

    /// Re-resolve + (re)spawn if not currently up. Recovers from crashed /
    /// unsupported / external_squatter. No-op when a child is alive/starting.
    pub fn restart(&self) -> bool {
        let shared = {
            let mut g = self.inner.lock().unwrap();
            if g.child_pid.is_some()
                || g.state.0 == SwfState::Starting
                || g.state.0 == SwfState::Running
            {
                return false;
            }
            g.expect_quit = false;
            g.restart_count = 0;
            g.state = StateField(SwfState::Idle);
            self.inner.clone()
        };
        tauri::async_runtime::spawn(async move {
            begin(shared).await;
        });
        true
    }

    /// Debounced focus/activate recheck (ported from main.js recheckDaemon).
    pub fn recheck(&self) {
        self.restart();
    }

    /// Graceful shutdown: SIGTERM, then SIGKILL after the grace window.
    /// Resolves once the child has exited. Safe when not running.
    pub async fn stop(&self) {
        let (pid, rx) = {
            let mut g = self.inner.lock().unwrap();
            g.expect_quit = true;
            match g.child_pid {
                None => {
                    if g.state.0 != SwfState::Crashed && g.state.0 != SwfState::Unsupported {
                        set_state(&mut g, SwfState::Idle);
                    }
                    return;
                }
                Some(pid) => {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    g.quit_tx = Some(tx);
                    (pid, rx)
                }
            }
        };
        kill_pid(pid, false);
        if tokio::time::timeout(Duration::from_millis(SIGTERM_GRACE_MS), rx)
            .await
            .is_err()
        {
            eprintln!("[swf-node] SIGTERM grace expired — SIGKILL");
            kill_pid(pid, true);
        }
    }
}

fn set_state(g: &mut Inner, next: SwfState) {
    if g.state.0 == next {
        return;
    }
    let prev = g.state.0;
    g.state = StateField(next);
    eprintln!("[swf-node] state: {} → {}", prev.as_str(), next.as_str());
    if let Some(app) = &g.app {
        let _ = app.emit("swf-node://status", next.as_str());
    }
}

/// Entry: resolve binary, prep dirs/token, probe for a squatter, then spawn.
async fn begin(shared: Shared) {
    // SWF_NODE_DISABLE=1 → unsupported.
    if std::env::var("SWF_NODE_DISABLE").as_deref() == Ok("1") {
        let mut g = shared.lock().unwrap();
        set_state(&mut g, SwfState::Unsupported);
        return;
    }

    let app = { shared.lock().unwrap().app.clone() };
    let Some(app) = app else { return };

    // Resolve the binary (packaged: resource_dir/swf-node/<bin>; dev: $SWF_NODE_BIN).
    let bin = match resolve_binary(&app) {
        Some(p) => p,
        None => {
            let mut g = shared.lock().unwrap();
            set_state(&mut g, SwfState::Unsupported);
            return;
        }
    };

    let user_data = crate::paths::user_data(&app);
    let data_dir = user_data.join("swf-node-data");
    let log_path = user_data.join("swf-node.log");
    let _ = std::fs::create_dir_all(&data_dir);
    let cohort_keys = ensure_cohort_keys(&app, &data_dir);

    {
        let mut g = shared.lock().unwrap();
        g.binary_path = Some(bin);
        g.data_dir = Some(data_dir);
        g.log_path = Some(log_path);
        g.cohort_keys_path = Some(cohort_keys);
        g.restart_count = 0;
    }

    // Probe BEFORE spawn — a foreign daemon on :7777 means skip + latch.
    if let Some(existing) = probe_indrex().await {
        let ver = existing
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("(unknown)")
            .to_string();
        eprintln!("[swf-node] external swf-node detected on :{PORT} (version=\"{ver}\") — skipping spawn");
        let mut g = shared.lock().unwrap();
        g.external_daemon = Some(serde_json::json!({ "version": ver, "indrex": existing }));
        set_state(&mut g, SwfState::ExternalSquatter);
        return;
    }

    spawn_child(shared);
}

fn resolve_binary(app: &AppHandle) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "swf-node.exe" } else { "swf-node" };
    if cfg!(dev) {
        // Dev: only spawn when explicitly opted in (avoid racing a user's own daemon).
        let p = PathBuf::from(std::env::var("SWF_NODE_BIN").ok()?);
        return p.exists().then_some(p);
    }
    let p = app
        .path()
        .resource_dir()
        .ok()?
        .join("swf-node")
        .join(bin_name);
    p.exists().then_some(p)
}

fn ensure_cohort_keys(app: &AppHandle, data_dir: &std::path::Path) -> PathBuf {
    let dst = data_dir.join("cohort-keys.json");
    if dst.exists() {
        return dst;
    }
    let seed = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("cohort-keys.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{\n  \"version\": 1,\n  \"members\": []\n}\n".to_string());
    let _ = std::fs::write(&dst, seed);
    dst
}

fn resolve_agent_token(g: &mut Inner) -> String {
    if let Some(t) = &g.agent_token {
        return t.clone();
    }
    if let Ok(env_tok) = std::env::var("SWF_AGENT_TOKEN") {
        if env_tok.len() >= 16 {
            g.agent_token = Some(env_tok.clone());
            return env_tok;
        }
    }
    let token_path = g.data_dir.as_ref().unwrap().join("agent_token");
    if let Ok(on_disk) = std::fs::read_to_string(&token_path) {
        let on_disk = on_disk.trim().to_string();
        if on_disk.len() >= 16 {
            g.agent_token = Some(on_disk.clone());
            return on_disk;
        }
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let _ = write_secret(&token_path, &format!("{token}\n"));
    g.agent_token = Some(token.clone());
    token
}

#[cfg(unix)]
fn write_secret(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_secret(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)
}

/// Spawn the child + the grace timer, line readers, and exit watcher.
/// Called only from within an async task (Tauri's tokio runtime).
fn spawn_child(shared: Shared) {
    let (binary, data_dir, log_path, cohort_keys, token, generation) = {
        let mut g = shared.lock().unwrap();
        g.expect_quit = false;
        set_state(&mut g, SwfState::Starting);
        g.generation += 1;
        let token = resolve_agent_token(&mut g);
        (
            g.binary_path.clone().unwrap(),
            g.data_dir.clone().unwrap(),
            g.log_path.clone().unwrap(),
            g.cohort_keys_path.clone().unwrap(),
            token,
            g.generation,
        )
    };

    // Per-spawn private TMPDIR (the PyInstaller _MEI extraction fix).
    let tmpdir = {
        let mut n = [0u8; 8];
        rand::rngs::OsRng.fill_bytes(&mut n);
        let d = std::env::temp_dir().join(format!("swf-node-tmp-{}", hex(&n)));
        std::fs::create_dir_all(&d).ok().map(|_| d)
    };

    for sub in ["config", "world_knowledge", "state"] {
        let _ = std::fs::create_dir_all(data_dir.join(sub));
    }

    rotate_log_if_needed(&log_path);
    eprintln!("[swf-node] spawning {} (port={PORT})", binary.display());

    let mut cmd = Command::new(&binary);
    cmd.current_dir(&data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("SWF_BIND", "0.0.0.0")
        .env("SWF_PORT", PORT.to_string())
        .env("SWF_FULL", "1")
        .env("SWF_CONFIG_DIR", data_dir.join("config"))
        .env("SWF_KNOWLEDGE_DIR", data_dir.join("world_knowledge"))
        .env("SWF_STATE_DIR", data_dir.join("state"))
        .env("SWF_COHORT_KEYS_FILE", &cohort_keys)
        .env("SWF_TRUST_LAN_PEERS", "1")
        .env("SWF_AGENT_TOKEN", token);
    if let Some(t) = &tmpdir {
        cmd.env("TMPDIR", t);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[swf-node] spawn failed: {e}");
            handle_unexpected_exit(shared, generation);
            return;
        }
    };

    let pid = child.id();
    {
        shared.lock().unwrap().child_pid = pid;
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Grace timer → running if still starting.
    {
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(RUNNING_GRACE_MS)).await;
            let mut g = shared.lock().unwrap();
            if g.generation == generation && g.state.0 == SwfState::Starting {
                set_state(&mut g, SwfState::Running);
                g.restart_count = 0;
            }
        });
    }

    if let Some(out) = stdout {
        spawn_reader(shared.clone(), out, "stdout", log_path.clone(), generation);
    }
    if let Some(err) = stderr {
        spawn_reader(shared.clone(), err, "stderr", log_path.clone(), generation);
    }

    // Exit watcher.
    {
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            let status = child.wait().await;
            let mut g = shared.lock().unwrap();
            if g.generation != generation {
                return; // superseded by a newer spawn
            }
            g.child_pid = None;
            append_log(&log_path, "exit", &format!("status={status:?}\n"));
            if g.expect_quit {
                set_state(&mut g, SwfState::Idle);
                if let Some(tx) = g.quit_tx.take() {
                    let _ = tx.send(());
                }
                return;
            }
            drop(g);
            handle_unexpected_exit(shared.clone(), generation);
        });
    }
}

fn spawn_reader<R>(shared: Shared, reader: R, stream: &'static str, log_path: PathBuf, gen: u64)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut g = shared.lock().unwrap();
                if g.generation == gen && g.state.0 == SwfState::Starting {
                    set_state(&mut g, SwfState::Running);
                    g.restart_count = 0;
                }
            }
            append_log(&log_path, stream, &format!("{line}\n"));
        }
    });
}

fn handle_unexpected_exit(shared: Shared, gen: u64) {
    let should_restart = {
        let mut g = shared.lock().unwrap();
        if g.generation != gen {
            return;
        }
        g.restart_count += 1;
        if g.restart_count >= RESTART_LIMIT {
            eprintln!(
                "[swf-node] giving up after {} unexpected exits",
                g.restart_count
            );
            set_state(&mut g, SwfState::Crashed);
            false
        } else {
            eprintln!(
                "[swf-node] unexpected exit ({}/{}) — restart in {}ms",
                g.restart_count, RESTART_LIMIT, RESTART_BACKOFF_MS
            );
            true
        }
    };
    if should_restart {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(RESTART_BACKOFF_MS)).await;
            if shared.lock().unwrap().expect_quit {
                return;
            }
            spawn_child(shared);
        });
    }
}

/// GET http://127.0.0.1:7777/.well-known/indrex with a hard timeout.
/// Returns the parsed JSON on 200, else None. Never errors out.
async fn probe_indrex() -> Option<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(PROBE_TIMEOUT_MS))
        .build()
        .ok()?;
    let resp = client
        .get(format!("http://127.0.0.1:{PORT}/.well-known/indrex"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn kill_pid(pid: u32, hard: bool) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let sig = if hard { Signal::SIGKILL } else { Signal::SIGTERM };
        let _ = kill(Pid::from_raw(pid as i32), sig);
    }
    #[cfg(windows)]
    {
        let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
        if hard {
            args.push("/F".to_string());
        }
        let _ = std::process::Command::new("taskkill").args(&args).status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (pid, hard);
    }
}

fn rotate_log_if_needed(log_path: &std::path::Path) {
    if let Ok(meta) = std::fs::metadata(log_path) {
        if meta.len() >= LOG_MAX_BYTES {
            let rotated = log_path.with_extension("log.1");
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(log_path, rotated);
        }
    }
}

fn append_log(log_path: &std::path::Path, stream: &str, chunk: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let ts = chrono::Utc::now().to_rfc3339();
        let _ = write!(f, "[{ts}] [{stream}] {chunk}");
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
