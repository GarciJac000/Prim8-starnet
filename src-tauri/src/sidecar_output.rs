//! Keep what the sidecar says. The release build is a windows-subsystem app with no console, so the
//! sidecar's stdout/stderr used to go nowhere: a boot crash left only `exited_before_listening
//! code=Some(1)` in startup.log, with no reason, on every reinstall (0.14.0 support reports). Both
//! streams are now piped and drained on their own threads (a full pipe can never stall the sidecar),
//! redacted, and appended to a size-capped `sidecar.log` beside startup.log. The last lines of each
//! spawn stay in memory, so a spawn that never comes up can name its real error in startup.log and in
//! the startup-failure dialog.
//!
//! Nothing raw is ever written: every line passes `Redactor` first — the exact secret values this
//! shell put in (or let through to) the sidecar's environment, then vendor-shaped keys and tokens.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;

/// sidecar.log rolls over to sidecar.log.1 (one generation) past this size: at most ~4 MiB on disk.
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Lines kept in memory per spawn.
const TAIL_KEEP: usize = 200;
/// A runaway line (a dumped JSON blob with no newline) is clipped here, never buffered unbounded.
const LINE_MAX_BYTES: usize = 4096;
/// Lines of a failed spawn copied into startup.log.
pub(crate) const STARTUP_LOG_TAIL: usize = 40;
/// Lines shown in the startup-failure dialog. A message box has no scroll bar and wraps long lines in a
/// narrow column (a full 22-line Node report drew a 764 px box), so stack frames are collapsed to the
/// first few and the excerpt is capped; startup.log keeps every line.
const DIALOG_TAIL: usize = 20;
const DIALOG_FRAMES: usize = 3;
const DIALOG_LINE_CHARS: usize = 180;
/// Known secret values shorter than this are not matched (too likely to hit ordinary text).
const KNOWN_MIN: usize = 8;

/// The rotating sidecar.log. Each drained chunk is appended with its own open/close, so an erase,
/// a rotation or a user deleting the file never leaves a writer stuck on a dead handle.
pub(crate) struct SidecarLog {
    path: Option<PathBuf>,
    max_bytes: u64,
    write_lock: Mutex<()>,
}

impl SidecarLog {
    /// `sidecar.log` in the same directory as startup.log (the app-data dir).
    pub(crate) fn beside(startup_log: &Option<PathBuf>) -> Self {
        let path = startup_log
            .as_ref()
            .and_then(|p| p.parent())
            .map(|dir| dir.join("sidecar.log"));
        Self::at(path, LOG_MAX_BYTES)
    }

    fn at(path: Option<PathBuf>, max_bytes: u64) -> Self {
        Self {
            path,
            max_bytes,
            write_lock: Mutex::new(()),
        }
    }

    pub(crate) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// One line of the shell's own (spawn / exit markers). Never carries sidecar text.
    pub(crate) fn note(&self, line: &str) {
        self.append(&[format!("{} {line}", utc_stamp(SystemTime::now()))]);
    }

    /// Fail-soft: a log that cannot be written is skipped, never fatal and never blocking for long.
    fn append(&self, lines: &[String]) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        if lines.is_empty() {
            return;
        }
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let incoming: u64 = lines.iter().map(|l| l.len() as u64 + 1).sum();
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size + incoming > self.max_bytes {
            let rolled = rolled_path(path);
            if std::fs::rename(path, &rolled).is_err() {
                // The old generation is locked open somewhere: start over in place so the cap holds.
                let _ = std::fs::write(path, b"");
            }
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let mut buf = String::with_capacity(incoming as usize);
            for line in lines {
                buf.push_str(line);
                buf.push('\n');
            }
            let _ = file.write_all(buf.as_bytes());
        }
    }
}

fn rolled_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

/// One spawn's output: its redacted last lines, and whether its pipes have reached EOF.
#[derive(Clone)]
pub(crate) struct Capture(Arc<CaptureShared>);

struct CaptureShared {
    pid: u32,
    state: Mutex<CaptureState>,
    drained: Condvar,
    /// Set once this spawn's tail went into startup.log, so the guardian does not repeat it.
    reported: AtomicBool,
}

struct CaptureState {
    tail: VecDeque<String>,
    open_streams: usize,
}

impl Capture {
    pub(crate) fn pid(&self) -> u32 {
        self.0.pid
    }

    /// The last `n` lines (already redacted), oldest first.
    pub(crate) fn tail(&self, n: usize) -> Vec<String> {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let skip = state.tail.len().saturating_sub(n);
        state.tail.iter().skip(skip).cloned().collect()
    }

    /// Wait (bounded) until every stream hit EOF. The pipes close when the child is gone, but a
    /// grandchild that inherited them can keep them open, so this never waits past `timeout`.
    pub(crate) fn wait_drained(&self, timeout: Duration) -> bool {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let (state, _) = self
            .0
            .drained
            .wait_timeout_while(state, timeout, |s| s.open_streams > 0)
            .unwrap_or_else(|e| e.into_inner());
        state.open_streams == 0
    }

    /// True the first time it is called for this spawn.
    pub(crate) fn take_report(&self) -> bool {
        !self.0.reported.swap(true, Ordering::SeqCst)
    }
}

/// Start draining a freshly spawned sidecar's pipes. Each stream gets its own thread that reads until
/// EOF, so the sidecar can never block on a full pipe and never sees EPIPE from a closed reader.
pub(crate) fn attach(
    log: &Arc<SidecarLog>,
    redactor: Redactor,
    pid: u32,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
) -> Capture {
    let mut streams: Vec<(&'static str, Box<dyn Read + Send>)> = Vec::new();
    if let Some(out) = stdout {
        streams.push(("out", Box::new(out)));
    }
    if let Some(err) = stderr {
        streams.push(("err", Box::new(err)));
    }
    attach_streams(log, redactor, pid, streams)
}

fn attach_streams(
    log: &Arc<SidecarLog>,
    redactor: Redactor,
    pid: u32,
    streams: Vec<(&'static str, Box<dyn Read + Send>)>,
) -> Capture {
    let capture = Capture(Arc::new(CaptureShared {
        pid,
        state: Mutex::new(CaptureState {
            tail: VecDeque::with_capacity(TAIL_KEEP),
            open_streams: streams.len(),
        }),
        drained: Condvar::new(),
        reported: AtomicBool::new(false),
    }));
    log.note(&format!("=== engine pid={pid} started ==="));
    let redactor = Arc::new(redactor);
    for (stream, reader) in streams {
        let sink = Sink {
            capture: capture.clone(),
            log: Arc::clone(log),
            redactor: Arc::clone(&redactor),
            stream,
        };
        let spawned = std::thread::Builder::new()
            .name(format!("sidecar-{stream}"))
            .spawn(move || sink.drain(reader));
        if let Err(error) = spawned {
            // The reader went down with the closure; count the stream closed so waits do not hang.
            log.note(&format!("engine pid={pid} {stream}: drain thread failed to start: {error}"));
            capture.close_stream();
        }
    }
    capture
}

impl Capture {
    fn push(&self, lines: &[String]) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        for line in lines {
            if state.tail.len() == TAIL_KEEP {
                state.tail.pop_front();
            }
            state.tail.push_back(line.clone());
        }
    }

    fn close_stream(&self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.open_streams = state.open_streams.saturating_sub(1);
        self.0.drained.notify_all();
    }
}

struct Sink {
    capture: Capture,
    log: Arc<SidecarLog>,
    redactor: Arc<Redactor>,
    stream: &'static str,
}

impl Sink {
    fn drain(self, mut reader: Box<dyn Read + Send>) {
        let mut buf = [0u8; 8192];
        let mut line: Vec<u8> = Vec::new();
        let mut clipped = false;
        let mut in_private_key = false;
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let mut lines = Vec::new();
            for &byte in &buf[..n] {
                if byte == b'\n' {
                    lines.push(self.finish(&mut line, &mut clipped, &mut in_private_key));
                } else if line.len() < LINE_MAX_BYTES {
                    line.push(byte);
                } else {
                    clipped = true;
                }
            }
            self.emit(&lines);
        }
        if !line.is_empty() {
            let last = self.finish(&mut line, &mut clipped, &mut in_private_key);
            self.emit(&[last]);
        }
        self.capture.close_stream();
    }

    fn finish(&self, line: &mut Vec<u8>, clipped: &mut bool, in_private_key: &mut bool) -> String {
        let raw = String::from_utf8_lossy(line).into_owned();
        line.clear();
        let mut text = self.redactor.redact_line(&raw, in_private_key);
        if *clipped {
            text.push_str(" …[clipped]");
            *clipped = false;
        }
        text
    }

    fn emit(&self, lines: &[String]) {
        if lines.is_empty() {
            return;
        }
        self.capture.push(lines);
        let stamp = utc_stamp(SystemTime::now());
        let pid = self.capture.pid();
        let stream = self.stream;
        let formatted: Vec<String> = lines
            .iter()
            .map(|l| format!("{stamp} [{pid} {stream}] {l}"))
            .collect();
        if cfg!(debug_assertions) {
            // Dev builds have a console; keep the sidecar visible there as before (redacted). A
            // fallible write, never eprintln!: a broken console must not panic the drain thread.
            let mut console = io::stderr().lock();
            for line in lines {
                let _ = writeln!(console, "[sidecar] {line}");
            }
        }
        self.log.append(&formatted);
    }
}

/// Scrubs one line of sidecar output: the exact secret values from the sidecar's environment first
/// (they have no shape — a service key, the IPC token), then vendor-shaped secrets (the patterns
/// mirror sidecar/context.js SECRET_PATTERNS), then terminal escapes and control characters.
pub(crate) struct Redactor {
    known: Vec<String>,
}

impl Redactor {
    /// Every secret-named variable the child will see: the ones this shell set on `cmd` and the ones
    /// it inherits from the shell's own environment (an OPENAI_API_KEY in the user's profile).
    pub(crate) fn for_command(cmd: &Command) -> Self {
        let mut pairs: Vec<(String, String)> = std::env::vars_os()
            .map(|(k, v)| (os(&k), os(&v)))
            .collect();
        for (name, value) in cmd.get_envs() {
            if let Some(value) = value {
                pairs.push((os(name), os(value)));
            }
        }
        Self::from_env(pairs)
    }

    fn from_env(pairs: Vec<(String, String)>) -> Self {
        let mut known: Vec<String> = Vec::new();
        for (name, value) in pairs {
            if is_secret_env_name(&name) {
                collect_secret_parts(&value, &mut known);
            }
        }
        known.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        known.dedup();
        Self { known }
    }

    pub(crate) fn redact_line(&self, raw: &str, in_private_key: &mut bool) -> String {
        let mut text = clean_terminal_text(raw);
        if *in_private_key {
            if text.contains("PRIVATE KEY-----") && text.contains("-----END") {
                *in_private_key = false;
            }
            return "[redacted-private-key]".to_string();
        }
        if text.contains("-----BEGIN") && text.contains("PRIVATE KEY-----") {
            *in_private_key = !text.contains("-----END");
            return "[redacted-private-key]".to_string();
        }
        for value in &self.known {
            if text.contains(value.as_str()) {
                text = text.replace(value.as_str(), "[redacted-secret]");
            }
        }
        for (pattern, replacement) in secret_patterns() {
            if pattern.is_match(&text) {
                text = pattern.replace_all(&text, *replacement).into_owned();
            }
        }
        text
    }
}

fn os(s: &OsStr) -> String {
    s.to_string_lossy().into_owned()
}

fn is_secret_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if upper.ends_with("_ERROR") {
        return false; // STARNET_CONNECTOR_KEY_ERROR is a human reason, not a key
    }
    [
        "KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "AUTH",
        "COOKIE",
        "PRIVATE",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

/// The value itself plus every part that can surface alone: pool members (comma lists), Slack's
/// "xoxb-… xapp-…" pair, and the string leaves of a JSON map (SKYNET_TELEGRAM_BOT_TOKENS).
fn collect_secret_parts(value: &str, out: &mut Vec<String>) {
    let mut add = |part: &str| {
        let part = part.trim();
        if part.chars().count() >= KNOWN_MIN {
            out.push(part.to_string());
        }
    };
    add(value);
    for part in value.split(|c: char| c == ',' || c.is_whitespace()) {
        add(part);
    }
    let trimmed = value.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(value) {
            let mut leaves = Vec::new();
            json_string_leaves(&json, 0, &mut leaves);
            for leaf in leaves {
                add(&leaf);
                for part in leaf.split(|c: char| c == ',' || c.is_whitespace()) {
                    add(part);
                }
            }
        }
    }
}

fn json_string_leaves(value: &serde_json::Value, depth: usize, out: &mut Vec<String>) {
    if depth > 8 || out.len() > 2000 {
        return;
    }
    match value {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(items) => {
            for item in items {
                json_string_leaves(item, depth + 1, out);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                json_string_leaves(item, depth + 1, out);
            }
        }
        _ => {}
    }
}

/// Strip ANSI escapes and control characters (tabs become spaces) so a dialog shows plain text.
fn clean_terminal_text(raw: &str) -> String {
    static ANSI: OnceLock<Option<Regex>> = OnceLock::new();
    let raw = raw.strip_suffix('\r').unwrap_or(raw);
    let stripped = match ANSI.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").ok()) {
        Some(re) => re.replace_all(raw, ""),
        None => raw.into(),
    };
    stripped
        .chars()
        .filter_map(|c| match c {
            '\t' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

const SECRET_PATTERN_SOURCES: &[(&str, &str)] = &[
    (r"sk-or-v1-[A-Za-z0-9_\-]{8,}", "[redacted-key]"),
    (r"sk-ant-[A-Za-z0-9_\-]{8,}", "[redacted-key]"),
    (r"sk-proj-[A-Za-z0-9_\-]{16,}", "[redacted-key]"),
    (r"\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b", "[redacted-key]"),
    (r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b", "[redacted-key]"),
    (r"\bAIza[0-9A-Za-z_\-]{35}\b", "[redacted-key]"),
    (r"\bya29\.[0-9A-Za-z_\-]{20,}", "[redacted-key]"),
    (r"\bgh[pousr]_[A-Za-z0-9]{36,}\b", "[redacted-key]"),
    (r"\bgithub_pat_[A-Za-z0-9_]{60,}\b", "[redacted-key]"),
    (r"\bglpat-[A-Za-z0-9_\-]{20,}\b", "[redacted-key]"),
    (r"\bxox[abeprs]-[A-Za-z0-9-]{10,}\b", "[redacted-key]"),
    (r"\bxapp-\d-[A-Za-z0-9-]{10,}\b", "[redacted-key]"),
    (r"\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b", "[redacted-token]"),
    (r"\bsyt_[A-Za-z0-9_]{10,}\b", "[redacted-token]"),
    (r"\b1//0[A-Za-z0-9_-]{30,}", "[redacted-token]"),
    (r"\bgsk_[A-Za-z0-9]{20,}\b", "[redacted-key]"),
    (r"\bpplx-[A-Za-z0-9]{20,}\b", "[redacted-key]"),
    (r"\bntn_[A-Za-z0-9]{20,}\b", "[redacted-key]"),
    (r"\blin_api_[A-Za-z0-9]{20,}\b", "[redacted-key]"),
    (r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}", "[redacted-key]"),
    (r"\bwhk_[A-Za-z0-9_-]{20,}", "[redacted-secret]"),
    (r"\bhf_[A-Za-z0-9]{30,}\b", "[redacted-key]"),
    (r"\bxai-[A-Za-z0-9]{20,}\b", "[redacted-key]"),
    (r"\bAC[a-f0-9]{32}\b", "[redacted-key]"),
    (r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}", "[redacted-jwt]"),
    (r"\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b", "[redacted-token]"),
    (r"sk-[A-Za-z0-9_\-]{16,}", "[redacted-key]"),
    (r"\bBearer\s+[A-Za-z0-9._\-]{12,}", "Bearer [redacted-key]"),
    // `user:pass@host` in a URL: the password runs to the LAST '@' of the authority; a port is untouched.
    (r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/?#@]*:)[^\s/?#]+@", "${1}[redacted-secret]@"),
    (
        r#"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|bot[_-]?token|webhook[_-]?secret|password|passwd|authorization)\b(["']?\s*[=:]\s*["']?)[^\s&,;"'\[][^\s&,;"']{3,}"#,
        "${1}${2}[redacted-secret]",
    ),
];

fn secret_patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        SECRET_PATTERN_SOURCES
            .iter()
            .filter_map(|(source, replacement)| Regex::new(source).ok().map(|re| (re, *replacement)))
            .collect()
    })
}

/// startup.log block for a spawn that never came up. Every line is prefixed so no engine text can be
/// mistaken for the shell's own `spawn_sidecar pid=… port=… listening=…` records (bin/lib/cli-core.js).
pub(crate) fn startup_log_block(pid: u32, tail: &[String], sidecar_log: Option<&Path>) -> String {
    let full = match sidecar_log {
        Some(p) => format!("full output: {}", p.display()),
        None => "no sidecar.log path was available".to_string(),
    };
    if tail.is_empty() {
        return format!("sidecar_output pid={pid}: the engine printed nothing before it stopped ({full})");
    }
    let mut block = format!(
        "sidecar_output pid={pid}: last {} line(s) the engine printed, redacted ({full}):",
        tail.len()
    );
    for line in tail {
        block.push_str("\n  | ");
        block.push_str(line);
    }
    block
}

/// The engine's own words for the startup-failure dialog: its last lines with each stack trace cut to
/// its first frames, each line clipped to fit a box.
pub(crate) fn dialog_excerpt(tail: &[String]) -> Option<String> {
    let mut collapsed: Vec<String> = Vec::with_capacity(tail.len());
    let mut run = 0usize;
    let flush = |collapsed: &mut Vec<String>, run: &mut usize| {
        if *run > DIALOG_FRAMES {
            collapsed.push(format!(
                "    … {} more stack frame(s) in startup.log",
                *run - DIALOG_FRAMES
            ));
        }
        *run = 0;
    };
    for line in tail {
        if line.trim_start().starts_with("at ") && line.starts_with(char::is_whitespace) {
            run += 1;
            if run <= DIALOG_FRAMES {
                collapsed.push(line.clone());
            }
        } else {
            flush(&mut collapsed, &mut run);
            collapsed.push(line.clone());
        }
    }
    flush(&mut collapsed, &mut run);
    let skip = collapsed.len().saturating_sub(DIALOG_TAIL);
    let lines: Vec<String> = collapsed
        .iter()
        .skip(skip)
        .map(|line| {
            if line.chars().count() > DIALOG_LINE_CHARS {
                let head: String = line.chars().take(DIALOG_LINE_CHARS).collect();
                format!("{head}…")
            } else {
                line.clone()
            }
        })
        .collect();
    if lines.iter().all(|l| l.trim().is_empty()) {
        return None;
    }
    Some(lines.join("\n"))
}

/// `2026-10-25T18:03:11Z` without a date crate (Hinnant's days-to-civil).
fn utc_stamp(at: SystemTime) -> String {
    let secs = at.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "starnet-sidecar-output-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn no_secrets() -> Redactor {
        Redactor::from_env(Vec::new())
    }

    fn redact(r: &Redactor, line: &str) -> String {
        r.redact_line(line, &mut false)
    }

    #[test]
    fn every_secret_pattern_compiles() {
        assert_eq!(secret_patterns().len(), SECRET_PATTERN_SOURCES.len());
    }

    #[test]
    fn known_env_secrets_are_scrubbed_whole_and_in_parts() {
        let r = Redactor::from_env(vec![
            ("SKYNET_IPC_TOKEN".into(), "ipc-0123456789abcdef".into()),
            ("SKYNET_KEY_POOL_OPENAI".into(), "pool-member-one,pool-member-two".into()),
            (
                "SKYNET_TELEGRAM_BOT_TOKENS".into(),
                r#"{"ultron":"12345:telegram-secret-part"}"#.into(),
            ),
            ("SKYNET_SLACK_TOKEN".into(), "slackbot-aaaa slackapp-bbbb".into()),
            ("STARNET_CONNECTOR_KEY_ERROR".into(), "keychain unavailable".into()),
            ("SKYNET_PORT".into(), "4567890123".into()),
            ("MY_SERVICE_PASSWORD".into(), "hunter2-but-longer".into()),
        ]);
        let line = "boot ipc-0123456789abcdef pool-member-two 12345:telegram-secret-part slackapp-bbbb hunter2-but-longer";
        let out = redact(&r, line);
        for secret in [
            "ipc-0123456789abcdef",
            "pool-member-two",
            "telegram-secret-part",
            "slackapp-bbbb",
            "hunter2-but-longer",
        ] {
            assert!(!out.contains(secret), "{secret} leaked: {out}");
        }
        assert!(out.starts_with("boot [redacted-secret]"), "{out}");
        // Non-secret names stay readable: the error reason and the port are not keys.
        assert_eq!(redact(&r, "keychain unavailable on 4567890123"), "keychain unavailable on 4567890123");
        // A JSON key (an agent name) is not a secret.
        assert_eq!(redact(&r, "agent ultron ready"), "agent ultron ready");
    }

    #[test]
    fn vendor_shaped_secrets_are_scrubbed() {
        let r = no_secrets();
        let cases = [
            ("key sk-or-v1-abcdefghijklmnop end", "key [redacted-key] end"),
            ("x sk-ant-api03-abcdefghijkl", "x [redacted-key]"),
            ("Authorization: Bearer abcdefghijklmnopqrstuv", "Authorization: [redacted-secret] [redacted-key]"),
            ("tg 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "tg [redacted-token]"),
            ("git https://andrew:p@ss@github.com/x", "git https://andrew:[redacted-secret]@github.com/x"),
            (r#"{"refresh_token": "opaque-refresh-value"}"#, r#"{"refresh_token": "[redacted-secret]"}"#),
            ("password=letmein123&next=1", "password=[redacted-secret]&next=1"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(&r, input), expected, "input: {input}");
        }
        // Ordinary crash text survives untouched.
        let frame = r"    at Object.<anonymous> (C:\Program Files\StarNet\sidecar\index.js:12:11)";
        assert_eq!(redact(&r, frame), frame);
        assert_eq!(redact(&r, "listening on 127.0.0.1:8787/api"), "listening on 127.0.0.1:8787/api");
    }

    #[test]
    fn private_key_blocks_are_scrubbed_across_lines() {
        let r = no_secrets();
        let mut in_key = false;
        let lines = [
            "before",
            "-----BEGIN RSA PRIVATE KEY-----",
            "MIIEpAIBAAKCAQEAplainbase64body",
            "-----END RSA PRIVATE KEY-----",
            "after",
        ];
        let out: Vec<String> = lines.iter().map(|l| r.redact_line(l, &mut in_key)).collect();
        assert_eq!(
            out,
            vec![
                "before",
                "[redacted-private-key]",
                "[redacted-private-key]",
                "[redacted-private-key]",
                "after"
            ]
        );
    }

    #[test]
    fn terminal_escapes_and_control_characters_are_stripped() {
        let r = no_secrets();
        assert_eq!(redact(&r, "\x1b[31mError:\x1b[0m boom\r"), "Error: boom");
        assert_eq!(redact(&r, "a\tb\x07c"), "a bc");
    }

    #[test]
    fn drained_output_reaches_the_tail_and_the_log_redacted() {
        let dir = temp_dir("drain");
        let log = Arc::new(SidecarLog::at(Some(dir.join("sidecar.log")), LOG_MAX_BYTES));
        let redactor = Redactor::from_env(vec![("SKYNET_API_TOKEN".into(), "api-token-0123456789".into())]);
        let stderr: Box<dyn Read + Send> = Box::new(io::Cursor::new(
            b"C:\\sidecar\\index.js:1\r\nError: boot failed with api-token-0123456789\n    at main\nNode.js v22".to_vec(),
        ));
        let stdout: Box<dyn Read + Send> = Box::new(io::Cursor::new(b"[boot] starting\n".to_vec()));
        let capture = attach_streams(&log, redactor, 4242, vec![("out", stdout), ("err", stderr)]);
        assert!(capture.wait_drained(Duration::from_secs(5)));
        let tail = capture.tail(40);
        assert!(tail.contains(&"Error: boot failed with [redacted-secret]".to_string()), "{tail:?}");
        assert!(tail.contains(&"Node.js v22".to_string()), "a last line without a newline is kept: {tail:?}");
        let written = std::fs::read_to_string(dir.join("sidecar.log")).unwrap();
        assert!(written.contains("=== engine pid=4242 started ==="));
        assert!(written.contains("[4242 err] Error: boot failed with [redacted-secret]"));
        assert!(written.contains("[4242 out] [boot] starting"));
        assert!(!written.contains("api-token-0123456789"));
        assert!(capture.take_report());
        assert!(!capture.take_report(), "a spawn's tail is reported once");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_runaway_line_is_clipped_and_the_tail_is_bounded() {
        let dir = temp_dir("bounds");
        let log = Arc::new(SidecarLog::at(Some(dir.join("sidecar.log")), LOG_MAX_BYTES));
        let mut bytes = vec![b'x'; LINE_MAX_BYTES * 3];
        bytes.push(b'\n');
        for i in 0..(TAIL_KEEP + 50) {
            bytes.extend_from_slice(format!("line {i}\n").as_bytes());
        }
        let reader: Box<dyn Read + Send> = Box::new(io::Cursor::new(bytes));
        let capture = attach_streams(&log, no_secrets(), 7, vec![("err", reader)]);
        assert!(capture.wait_drained(Duration::from_secs(5)));
        let all = capture.tail(usize::MAX);
        assert_eq!(all.len(), TAIL_KEEP);
        assert_eq!(all.last().unwrap(), &format!("line {}", TAIL_KEEP + 49));
        assert_eq!(capture.tail(3).len(), 3);
        let written = std::fs::read_to_string(dir.join("sidecar.log")).unwrap();
        let long = written.lines().find(|l| l.contains("xxxx")).unwrap();
        assert!(long.ends_with("…[clipped]") && long.len() < LINE_MAX_BYTES + 100);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_log_rolls_over_to_one_previous_generation() {
        let dir = temp_dir("rotate");
        let path = dir.join("sidecar.log");
        let log = SidecarLog::at(Some(path.clone()), 200);
        for i in 0..20 {
            log.append(&[format!("entry {i:02} padding padding")]);
        }
        let current = std::fs::metadata(&path).unwrap().len();
        let rolled = std::fs::metadata(dir.join("sidecar.log.1")).unwrap().len();
        assert!(current <= 200 && rolled <= 200, "current={current} rolled={rolled}");
        assert!(std::fs::read_to_string(&path).unwrap().contains("entry 19"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_log_without_a_path_still_keeps_the_tail() {
        let log = Arc::new(SidecarLog::beside(&None));
        assert!(log.path().is_none());
        let reader: Box<dyn Read + Send> = Box::new(io::Cursor::new(b"Error: x\n".to_vec()));
        let capture = attach_streams(&log, no_secrets(), 1, vec![("err", reader)]);
        assert!(capture.wait_drained(Duration::from_secs(5)));
        assert_eq!(capture.tail(40), vec!["Error: x".to_string()]);
    }

    #[test]
    fn startup_log_block_is_prefixed_and_never_reads_as_a_spawn_record() {
        let tail = vec![
            "spawn_sidecar pid=1 port=2 listening=true".to_string(),
            "Error: boom".to_string(),
        ];
        let block = startup_log_block(99, &tail, Some(Path::new("C:/data/sidecar.log")));
        let mut lines = block.lines();
        assert!(lines.next().unwrap().starts_with("sidecar_output pid=99: last 2 line(s)"));
        assert!(block.lines().skip(1).all(|l| l.starts_with("  | ")));
        assert!(block.contains("C:/data/sidecar.log"));
        let empty = startup_log_block(5, &[], None);
        assert!(empty.contains("printed nothing"));
    }

    #[test]
    fn dialog_excerpt_keeps_the_last_lines_and_clips_wide_ones() {
        let tail: Vec<String> = (0..40).map(|i| format!("line {i}")).collect();
        let excerpt = dialog_excerpt(&tail).unwrap();
        assert_eq!(excerpt.lines().count(), DIALOG_TAIL);
        assert!(excerpt.ends_with("line 39"));
        let wide = vec!["y".repeat(DIALOG_LINE_CHARS + 50)];
        let clipped = dialog_excerpt(&wide).unwrap();
        assert_eq!(clipped.chars().count(), DIALOG_LINE_CHARS + 1);
        assert!(dialog_excerpt(&[]).is_none());
        assert!(dialog_excerpt(&[" ".to_string()]).is_none());
    }

    #[test]
    fn dialog_excerpt_cuts_a_stack_trace_to_its_first_frames() {
        let mut tail = vec![
            "node:internal/modules/cjs/loader:1433".to_string(),
            "Error: Cannot find module 'x'".to_string(),
        ];
        tail.extend((0..10).map(|i| format!("    at frame{i} (node:internal/x:{i}:1)")));
        tail.push("Node.js v22.23.2".to_string());
        let excerpt = dialog_excerpt(&tail).unwrap();
        let lines: Vec<&str> = excerpt.lines().collect();
        assert_eq!(
            lines,
            vec![
                "node:internal/modules/cjs/loader:1433",
                "Error: Cannot find module 'x'",
                "    at frame0 (node:internal/x:0:1)",
                "    at frame1 (node:internal/x:1:1)",
                "    at frame2 (node:internal/x:2:1)",
                "    … 7 more stack frame(s) in startup.log",
                "Node.js v22.23.2",
            ]
        );
        // A trace that ends the output is collapsed too; prose that merely starts with "at" is not a frame.
        let ending = vec![
            "at least one store failed".to_string(),
            "    at a".to_string(),
            "    at b".to_string(),
            "    at c".to_string(),
            "    at d".to_string(),
        ];
        let excerpt = dialog_excerpt(&ending).unwrap();
        assert!(excerpt.starts_with("at least one store failed\n"));
        assert!(excerpt.ends_with("    … 1 more stack frame(s) in startup.log"));
    }

    #[test]
    fn utc_stamp_formats_known_instants() {
        assert_eq!(utc_stamp(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            utc_stamp(UNIX_EPOCH + Duration::from_secs(1_792_951_391)),
            "2026-10-25T18:03:11Z"
        );
        assert_eq!(
            utc_stamp(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00Z"
        );
    }
}
