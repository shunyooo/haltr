use anyhow::Result;
use crate::session;

pub fn enable(all: bool) -> Result<()> {
    if all {
        session::set_global_kill_switch(false)?;
        eprintln!("haltr enabled globally");
    } else {
        let session_id = session::get_session_id()
            .ok_or_else(|| anyhow::anyhow!("no session ID found (set HALTR_SESSION_ID or CLAUDE_SESSION_ID)"))?;
        let mut state = session::load(&session_id);
        state.hook_enabled = true;
        session::save(&session_id, &state)?;
        eprintln!("haltr enabled for session {}", &session_id[..8.min(session_id.len())]);
    }
    Ok(())
}

pub fn disable(all: bool) -> Result<()> {
    if all {
        session::set_global_kill_switch(true)?;
        eprintln!("haltr disabled globally");
    } else {
        let session_id = session::get_session_id()
            .ok_or_else(|| anyhow::anyhow!("no session ID found (set HALTR_SESSION_ID or CLAUDE_SESSION_ID)"))?;
        let mut state = session::load(&session_id);
        state.hook_enabled = false;
        session::save(&session_id, &state)?;
        eprintln!("haltr disabled for session {}", &session_id[..8.min(session_id.len())]);
    }
    Ok(())
}
