//! The terminal's own launches of StarNet (bin/starnet.js). `starnet` with the app closed starts it as
//! `--background --terminal-pid <pid>`: the app's own keychain read and keyed sidecar, exactly as when a person opens
//! it, with the window parked (the tray shows it runs). A second `starnet` session that attaches sends the same flags
//! to the running app (single-instance), so it runs for every terminal session it was started or joined for. When the
//! last of them has exited, main.rs decides as a window close does. Parsing and the "is that terminal still running"
//! probe live here, pure enough to test.

/// The exit code of a terminal-started StarNet whose engine failed and whose startup dialog was cancelled. `starnet`
/// waits on that process, and a 0 reads as a hand-off to a StarNet already starting (bin/starnet.js
/// APP_EXIT_START_CANCELLED says the same number).
pub const EXIT_START_CANCELLED: i32 = 3;

/// What a launch's arguments say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalLaunch {
    /// A person opening StarNet: no terminal flags.
    Person,
    /// A `starnet` session wants the station. `pid` is that terminal process (`--terminal-pid <n>`), 0 when not given.
    Background { pid: u32 },
}

pub fn parse<I, S>(args: I) -> TerminalLaunch
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut background = false;
    let mut pid = 0u32;
    let mut pid_next = false;
    for arg in args {
        let a = arg.as_ref();
        if pid_next {
            pid_next = false;
            pid = a.parse().unwrap_or(0);
        } else if a == "--background" {
            background = true;
        } else if a == "--terminal-pid" {
            pid_next = true;
        } else if let Some(v) = a.strip_prefix("--terminal-pid=") {
            pid = v.parse().unwrap_or(0);
        }
    }
    if background {
        TerminalLaunch::Background { pid }
    } else {
        TerminalLaunch::Person
    }
}

/// What this process's own launch arguments mean once it is up. A terminal launch whose terminal has already exited is
/// a person opening StarNet: an in-app update relaunches the app with the arguments it was started with (the updater
/// copies them, and app.restart() keeps them), and the installer has stopped that `starnet` (it runs on the bundled
/// node.exe), so the relaunched StarNet would otherwise park its window and close itself as a terminal close.
pub fn at_startup(launch: TerminalLaunch, running: impl Fn(u32) -> bool) -> TerminalLaunch {
    match launch {
        TerminalLaunch::Background { pid } if pid > 0 && !running(pid) => TerminalLaunch::Person,
        other => other,
    }
}

/// Is the terminal process `pid` still running? Exact on purpose: on Windows an exited process whose handle someone
/// still holds (a shell that has not collected it yet) is gone here, where a bare OpenProcess would say alive. A probe
/// that cannot tell (access denied) says running: a wrong "running" only keeps StarNet in the tray, a wrong "gone"
/// would close a station under a terminal still using it.
#[cfg(windows)]
pub fn terminal_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    if pid == 0 {
        return false;
    }
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        // Windows documents INVALID_PARAMETER for a pid that does not exist; anything else could be a live process.
        return (unsafe { GetLastError() }) != ERROR_INVALID_PARAMETER;
    }
    // signalled = exited; a timeout (or a failed wait, which proves nothing) = still running
    let waited = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    waited != WAIT_OBJECT_0
}

#[cfg(unix)]
pub fn terminal_running(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let Ok(pid) = i32::try_from(pid) else {
        return true;
    };
    if pid <= 0 {
        return false;
    }
    if unsafe { kill(pid, 0) } == 0 {
        return true;
    }
    // ESRCH (3 on macOS and Linux) is the only "no such process"; EPERM means it exists.
    std::io::Error::last_os_error().raw_os_error() != Some(3)
}

#[cfg(not(any(unix, windows)))]
pub fn terminal_running(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{at_startup, parse, terminal_running, TerminalLaunch};

    #[test]
    fn a_plain_launch_is_a_person_opening_starnet() {
        assert_eq!(parse(["skynet-desktop.exe"]), TerminalLaunch::Person);
        assert_eq!(parse(Vec::<String>::new()), TerminalLaunch::Person);
        assert_eq!(parse(["x", "--terminal-pid", "42"]), TerminalLaunch::Person, "a pid alone is not a terminal launch");
    }

    #[test]
    fn background_carries_the_terminal_pid_in_either_spelling() {
        assert_eq!(parse(["x", "--background", "--terminal-pid", "4242"]), TerminalLaunch::Background { pid: 4242 });
        assert_eq!(parse(["x", "--terminal-pid=77", "--background"]), TerminalLaunch::Background { pid: 77 });
        assert_eq!(parse(["x", "--background"]), TerminalLaunch::Background { pid: 0 });
    }

    #[test]
    fn a_pid_that_is_not_a_number_is_no_pid() {
        assert_eq!(parse(["x", "--background", "--terminal-pid", "abc"]), TerminalLaunch::Background { pid: 0 });
        assert_eq!(parse(["x", "--background", "--terminal-pid"]), TerminalLaunch::Background { pid: 0 });
        assert_eq!(parse(["x", "--background", "--terminal-pid=-5"]), TerminalLaunch::Background { pid: 0 });
        assert_eq!(parse(["x", "--backgroundx"]), TerminalLaunch::Person, "only the exact flag counts");
    }

    #[test]
    fn a_relaunch_for_a_terminal_that_has_exited_is_a_person_opening_starnet() {
        // the in-app update case: the updater relaunches with the old --background --terminal-pid, that starnet is gone
        let relaunch = parse(["x", "--background", "--terminal-pid", "4242"]);
        assert_eq!(at_startup(relaunch, |_| false), TerminalLaunch::Person);
        // a terminal still running keeps its launch
        assert_eq!(at_startup(relaunch, |pid| pid == 4242), TerminalLaunch::Background { pid: 4242 });
        // no pid to check: unchanged, and a person's launch is never asked about
        assert_eq!(at_startup(TerminalLaunch::Background { pid: 0 }, |_| false), TerminalLaunch::Background { pid: 0 });
        assert_eq!(at_startup(TerminalLaunch::Person, |_| panic!("not asked")), TerminalLaunch::Person);
    }

    #[test]
    fn a_real_exited_terminal_pid_at_startup_is_a_person() {
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd").args(["/C", "exit 0"]).spawn().expect("spawn cmd");
        #[cfg(unix)]
        let mut child = std::process::Command::new("true").spawn().expect("spawn true");
        let pid = child.id();
        child.wait().expect("wait");
        assert_eq!(at_startup(TerminalLaunch::Background { pid }, terminal_running), TerminalLaunch::Person);
        drop(child);
        let me = std::process::id();
        assert_eq!(at_startup(TerminalLaunch::Background { pid: me }, terminal_running), TerminalLaunch::Background { pid: me });
    }

    #[test]
    fn this_process_is_running_and_pid_zero_is_not() {
        assert!(terminal_running(std::process::id()));
        assert!(!terminal_running(0));
    }

    #[test]
    fn an_exited_process_is_gone_even_while_its_handle_is_still_held() {
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd").args(["/C", "exit 0"]).spawn().expect("spawn cmd");
        #[cfg(unix)]
        let mut child = std::process::Command::new("true").spawn().expect("spawn true");
        let pid = child.id();
        child.wait().expect("wait");
        // `child` still holds the process handle on Windows: a bare OpenProcess would call it alive
        assert!(!terminal_running(pid), "pid {pid} exited");
        drop(child);
    }
}
