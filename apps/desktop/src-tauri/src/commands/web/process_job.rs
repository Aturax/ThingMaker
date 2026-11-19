//! Keep shared Browse relays alive between chats, and stop the runtime's
//! descendants on desktop exit (including a crash). External relays are
//! outside this job and keep running.
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::LazyLock,
};
use tokio::process::Child;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
};

fn create() -> io::Result<OwnedHandle> {
    // An unnamed, non-inheritable job. Only this process holds its handle.
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() { return Err(io::Error::last_os_error()); }
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = unsafe { SetInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation,
        (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of_val(&limits) as u32) };
    if ok == 0 { return Err(io::Error::last_os_error()); }
    Ok(job)
}

fn assign(job: &OwnedHandle, child: &Child) -> io::Result<()> {
    let process = child.raw_handle().ok_or_else(|| io::Error::other("web runtime already exited"))?;
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn track(child: &Child) -> Result<(), String> {
    static JOB: LazyLock<io::Result<OwnedHandle>> = LazyLock::new(create);
    let job = JOB.as_ref().map_err(|e| format!("Could not create web process job: {e}"))?;
    assign(job, child).map_err(|e| format!("Could not track web processes: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, path::Path, process::Stdio, time::Duration};
    use tokio::{io::AsyncWriteExt, net::TcpStream, process::Command};

    async fn wait_for_port(port: u16, open: bool) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if TcpStream::connect(("127.0.0.1", port)).await.is_ok() == open { return; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }).await.expect("unexpected Browse relay lifecycle");
    }

    #[tokio::test]
    #[ignore = "requires the packaged Windows Web runtime"]
    async fn app_exit_closes_its_detached_browse_relay_and_preserves_external_relays() {
        let runtime = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-web");
        let browse = runtime.join("node_modules/@opencode/browse-windows-x64/bin/browse.exe");
        for existing in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let port = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
            let env = [("OPENCODE_BROWSER_HOME", home.path().to_str().unwrap().to_owned()),
                ("OPENCODE_BROWSER_PORT", port.to_string()), ("OPENCODE_BROWSER_AUTO_UPDATE", "off".into())];
            let mut external = if existing {
                let process = Command::new(&browse).arg("serve").envs(env.clone()).creation_flags(0x08000000)
                    .stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
                wait_for_port(port, true).await;
                Some(process)
            } else { None };
            let job = create().unwrap();
            // Match the packaged runtime's pair command after assigning its Node parent.
            let mut node = Command::new(runtime.join("node.exe")).arg("-e").arg(
                "process.stdin.once('data',()=>require('node:child_process').spawnSync(process.argv[1],['pair','--wait-seconds','0'],{stdio:'ignore',windowsHide:true}))"
            ).arg(&browse).envs(env).creation_flags(0x08000000).stdin(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
            assign(&job, &node).unwrap();
            node.stdin.take().unwrap().write_all(b"pair").await.unwrap();
            // Pair exits with a timeout when no extension connects. The relay remains live.
            let _ = tokio::time::timeout(Duration::from_secs(25), node.wait()).await.unwrap().unwrap();
            wait_for_port(port, true).await;
            drop(job);
            wait_for_port(port, existing).await;
            if let Some(child) = external.as_mut() {
                assert!(child.try_wait().unwrap().is_none());
                child.kill().await.unwrap();
            }
        }
    }
}
