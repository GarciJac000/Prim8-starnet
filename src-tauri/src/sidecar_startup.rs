//! Keep ownership of every startup attempt, including timed-out children.
use std::io;
use std::process::{Child, ChildStderr, ChildStdout, Command};
use std::sync::Mutex;

/// A tracked child plus its piped output, taken before the child is stored so nothing else holding
/// the slot can drop a pipe (a closed reader turns the sidecar's next log line into EPIPE).
#[derive(Debug)]
pub(crate) struct Spawned {
    pub(crate) pid: u32,
    pub(crate) stdout: Option<ChildStdout>,
    pub(crate) stderr: Option<ChildStderr>,
}

pub(crate) fn spawn(command: &mut Command, slot: &Mutex<Option<Child>>) -> io::Result<Spawned> {
    let mut tracked = slot
        .lock()
        .map_err(|_| io::Error::other("sidecar lock poisoned"))?;
    if let Some(child) = tracked.as_mut() {
        if child.try_wait()?.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "previous sidecar is still running",
            ));
        }
    }
    let mut child = command.spawn()?;
    let spawned = Spawned {
        pid: child.id(),
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
    };
    *tracked = Some(child);
    Ok(spawned)
}

/// Retain the reaped child so the guardian can count its failed attempt normally.
/// Never stop a replacement installed by a concurrent recovery operation.
pub(crate) fn stop_timed_out(slot: &Mutex<Option<Child>>, pid: u32) -> io::Result<()> {
    let mut tracked = slot
        .lock()
        .map_err(|_| io::Error::other("sidecar lock poisoned"))?;
    if let Some(child) = tracked.as_mut().filter(|child| child.id() == pid) {
        if child.try_wait()?.is_none() {
            child.kill()?;
        }
        child.wait()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sleeping_child() -> Command {
        #[cfg(windows)]
        let mut cmd = Command::new("powershell.exe");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            cmd.creation_flags(0x0800_0000);
        }
        #[cfg(not(windows))]
        let mut cmd = Command::new("sleep");
        #[cfg(not(windows))]
        cmd.arg("60");
        cmd
    }

    #[test]
    fn timeout_reaps_before_retry_and_does_not_stop_a_replacement() {
        let slot = Mutex::new(None);
        let first = spawn(&mut sleeping_child(), &slot).unwrap().pid;
        let duplicate = spawn(&mut sleeping_child(), &slot).unwrap_err();
        assert_eq!(duplicate.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(slot.lock().unwrap().as_ref().unwrap().id(), first);
        stop_timed_out(&slot, first).unwrap();
        assert!(slot
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some());
        let second = spawn(&mut sleeping_child(), &slot).unwrap().pid;
        stop_timed_out(&slot, first).unwrap();
        let still_running = slot
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none();
        stop_timed_out(&slot, second).unwrap();
        assert!(
            still_running,
            "a late timeout must not kill the replacement"
        );
    }

    #[test]
    fn spawn_failure_leaves_no_untracked_child() {
        let slot = Mutex::new(None);
        assert!(spawn(&mut Command::new("starnet-missing-runtime-test"), &slot).is_err());
        assert!(slot.lock().unwrap().is_none());
    }
}
