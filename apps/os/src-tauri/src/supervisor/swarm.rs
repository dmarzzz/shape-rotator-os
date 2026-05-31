//! research-swarm supervisor — Rust port of apps/os/swarm-node.js + the
//! main.js swarm IPC (config, key, ensure-swf-ready). Invoke-and-stream: one
//! `research-agent` process per query, stdout/stderr streamed to the renderer
//! as `swarm://output` events, exit reported via `swarm://status`.

use super::swf_node::SwfNode;
use crate::{json_store, paths, secrets};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Default)]
struct Inner {
    current: Option<Current>,
    generation: u64,
}

struct Current {
    pid: Option<u32>,
    started_ms: i64,
    started_at: Instant,
}

#[derive(Clone, Default)]
pub struct Swarm {
    inner: Arc<Mutex<Inner>>,
}

impl Swarm {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> Value {
        let g = self.inner.lock().unwrap();
        match &g.current {
            None => json!({ "state": "idle" }),
            Some(c) => json!({
                "state": "running",
                "startedAt": c.started_ms,
                "durationMs": c.started_at.elapsed().as_millis() as u64,
            }),
        }
    }

    fn is_running(&self) -> bool {
        self.inner.lock().unwrap().current.is_some()
    }

    pub fn config_get(&self, app: &AppHandle) -> Value {
        let cfg = json_store::read(&config_file(app));
        let lm_model = cfg
            .get("lmModel")
            .and_then(Value::as_str)
            .unwrap_or("anthropic/claude-sonnet-4-6");
        let lm_api_base = cfg.get("lmApiBase").and_then(Value::as_str).unwrap_or("");
        json!({
            "lmModel": lm_model,
            "lmApiBase": lm_api_base,
            "hasApiKey": secrets::read_key(app).is_some(),
            "agent": agent_info(app),
            "safeStorageAvailable": secrets::available(),
        })
    }

    pub fn config_set(&self, app: &AppHandle, opts: &Value) -> Value {
        let mut cfg = json_store::read(&config_file(app));
        if !cfg.is_object() {
            cfg = json!({});
        }
        let obj = cfg.as_object_mut().unwrap();
        if let Some(m) = opts.get("lmModel").and_then(Value::as_str) {
            obj.insert("lmModel".into(), json!(m.trim()));
        }
        if let Some(b) = opts.get("lmApiBase").and_then(Value::as_str) {
            obj.insert("lmApiBase".into(), json!(b.trim()));
        }
        let _ = json_store::write_atomic(&config_file(app), &cfg);
        // Optional key: present → store/clear.
        if let Some(k) = opts.get("lmApiKey") {
            secrets::write_key(app, k.as_str().filter(|s| !s.is_empty()));
        }
        json!({ "ok": true })
    }

    pub fn stop(&self) -> Value {
        let pid = {
            let g = self.inner.lock().unwrap();
            match &g.current {
                Some(c) => c.pid,
                None => return json!({ "ok": false, "reason": "not_running" }),
            }
        };
        if let Some(pid) = pid {
            kill_pid(pid, false);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(2000)).await;
                kill_pid(pid, true);
            });
        }
        json!({ "ok": true })
    }

    pub async fn start(&self, app: AppHandle, swf: &SwfNode, opts: Value) -> Value {
        if self.is_running() {
            return json!({ "ok": false, "reason": "swarm_already_running" });
        }

        // 1. swf-node must be reachable (agent routes web traffic through it).
        let swf_ready = ensure_swf_node_ready(swf).await;
        if swf_ready.get("ok").and_then(Value::as_bool) != Some(true) {
            return swf_ready;
        }
        let url = swf_ready
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("http://127.0.0.1:7777")
            .to_string();

        // 2. resolve binary.
        let Some(bin) = resolve_agent_binary(&app) else {
            return json!({
                "ok": false, "reason": "research_agent_not_found",
                "detail": "Set RESEARCH_AGENT_BIN or install research-swarm at ~/research-swarm"
            });
        };

        // 3. query.
        let query = opts.get("query").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if query.is_empty() {
            return json!({ "ok": false, "reason": "empty_query" });
        }

        // 4. config + key.
        let cfg = json_store::read(&config_file(&app));
        let lm_model = opts
            .get("lmModel")
            .and_then(Value::as_str)
            .or_else(|| cfg.get("lmModel").and_then(Value::as_str))
            .unwrap_or("anthropic/claude-sonnet-4-6")
            .to_string();
        let lm_api_base = opts
            .get("lmApiBase")
            .and_then(Value::as_str)
            .or_else(|| cfg.get("lmApiBase").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        let mut lm_api_key = opts
            .get("lmApiKey")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        if lm_api_key.is_empty() && lm_model.starts_with("anthropic/") {
            lm_api_key = secrets::read_key(&app).unwrap_or_default();
        }

        let request_id = opts
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("req_{}", rand_id()));
        let swf_token = swf.agent_token().unwrap_or_default();

        // 5. spawn (clean env, matching swarm-node.js).
        let agent_repo = bin
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());

        let mut args: Vec<String> = Vec::new();
        if opts.get("parallel").and_then(Value::as_bool) == Some(true) {
            args.push("--parallel".into());
        }
        if let Some(w) = opts.get("workers").and_then(Value::as_u64) {
            if w > 0 {
                args.push("--workers".into());
                args.push(w.to_string());
            }
        }
        args.push(query);

        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("LANG", std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()))
            .env("PYTHONUNBUFFERED", "1")
            .env("RA_BACKEND", "swf-node")
            .env("SWF_NODE_URL", &url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(repo) = &agent_repo {
            cmd.current_dir(repo);
        }
        if !lm_model.is_empty() {
            cmd.env("LM_MODEL", &lm_model);
        }
        if !lm_api_key.is_empty() {
            cmd.env("LM_API_KEY", &lm_api_key);
            if lm_model.starts_with("anthropic/") {
                cmd.env("ANTHROPIC_API_KEY", &lm_api_key);
            }
        }
        if !lm_api_base.is_empty() {
            cmd.env("LM_API_BASE", &lm_api_base);
        }
        if !swf_token.is_empty() {
            cmd.env("SWF_NODE_TOKEN", &swf_token);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return json!({ "ok": false, "reason": "spawn_failed", "detail": e.to_string() })
            }
        };
        let pid = child.id();
        let started_ms = chrono::Utc::now().timestamp_millis();
        let generation = {
            let mut g = self.inner.lock().unwrap();
            g.generation += 1;
            g.current = Some(Current {
                pid,
                started_ms,
                started_at: Instant::now(),
            });
            g.generation
        };
        let _ = app.emit(
            "swarm://status",
            json!({ "state": "running", "requestId": request_id, "startedAt": started_ms }),
        );

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(out) = stdout {
            spawn_reader(app.clone(), out, "stdout", request_id.clone());
        }
        if let Some(err) = stderr {
            spawn_reader(app.clone(), err, "stderr", request_id.clone());
        }

        let inner = self.inner.clone();
        let app2 = app.clone();
        let rid = request_id.clone();
        tauri::async_runtime::spawn(async move {
            let status = child.wait().await;
            let mut g = inner.lock().unwrap();
            if g.generation != generation {
                return;
            }
            let dur = g
                .current
                .as_ref()
                .map(|c| c.started_at.elapsed().as_millis() as u64)
                .unwrap_or(0);
            g.current = None;
            drop(g);
            let code = status.ok().and_then(|s| s.code());
            let _ = app2.emit(
                "swarm://status",
                json!({ "state": "idle", "requestId": rid, "exitCode": code, "durationMs": dur }),
            );
        });

        json!({ "ok": true, "requestId": request_id })
    }
}

fn spawn_reader<R>(app: AppHandle, reader: R, stream: &'static str, request_id: String)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            let _ = app.emit(
                "swarm://output",
                json!({ "requestId": request_id, "stream": stream, "line": line }),
            );
        }
    });
}

async fn ensure_swf_node_ready(swf: &SwfNode) -> Value {
    let url = std::env::var("SWF_NODE_URL").unwrap_or_else(|_| "http://127.0.0.1:7777".into());
    if wait_health(&url, 250).await {
        return json!({ "ok": true, "url": url });
    }
    let st = swf.status();
    if st != "running" && st != "starting" {
        swf.restart();
    }
    if wait_health(&url, 3000).await {
        return json!({ "ok": true, "url": url });
    }
    json!({
        "ok": false,
        "reason": "swf_node_unavailable",
        "detail": format!(
            "swf-node sidecar isn't responding on {url}. The swarm routes all of its web traffic \
             through swf-node so the atlas stays consistent — without it a run produces nothing. \
             Try the 'restart backend' affordance in the network tab."
        )
    })
}

async fn wait_health(url: &str, budget_ms: u64) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
    else {
        return false;
    };
    let endpoint = format!("{}/health", url.trim_end_matches('/'));
    let deadline = Instant::now() + Duration::from_millis(budget_ms);
    loop {
        if let Ok(resp) = client.get(&endpoint).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn resolve_agent_binary(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Ok(p) = std::env::var("RESEARCH_AGENT_BIN") {
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let bin_name = if cfg!(windows) {
        "research-agent.exe"
    } else {
        "research-agent"
    };
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("research-swarm").join(bin_name));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("research-swarm/.venv/bin/research-agent"));
        candidates.push(home.join("shape-rotator-field-kit/research-swarm/.venv/bin/research-agent"));
    }
    candidates.into_iter().find(|c| c.exists())
}

fn agent_info(app: &AppHandle) -> Value {
    let bin = resolve_agent_binary(app);
    json!({
        "binFound": bin.is_some(),
        "binPath": bin.map(|p| p.to_string_lossy().to_string()),
    })
}

fn config_file(app: &AppHandle) -> std::path::PathBuf {
    paths::user_data(app).join("swarm-config.json")
}

fn rand_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 5];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn kill_pid(pid: u32, hard: bool) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let _ = kill(
            Pid::from_raw(pid as i32),
            if hard { Signal::SIGKILL } else { Signal::SIGTERM },
        );
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
