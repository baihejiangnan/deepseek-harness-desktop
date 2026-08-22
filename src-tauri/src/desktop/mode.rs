use std::env;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunMode {
    Launcher,
    Instance { id: String },
}

impl RunMode {
    pub fn instance_id(&self) -> Option<&str> {
        match self {
            Self::Launcher => None,
            Self::Instance { id } => Some(id),
        }
    }

    pub fn app_user_model_id(&self) -> String {
        match self {
            Self::Launcher => "io.github.hairyf.deepseek-harness-desktop.launcher".to_string(),
            Self::Instance { id } => {
                let safe_id: String = id
                    .chars()
                    .map(|ch| {
                        if ch.is_ascii_alphanumeric() || ch == '-' {
                            ch
                        } else {
                            '-'
                        }
                    })
                    .collect();
                format!("io.github.hairyf.deepseek-harness-desktop.instance.{safe_id}")
            }
        }
    }
}

pub fn current() -> RunMode {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--mode" {
            if let Some(mode) = args.next() {
                if mode == "instance" {
                    if let Some(id) = args
                        .next()
                        .filter(|value| value == "--instance-id")
                        .and_then(|_| args.next())
                    {
                        return RunMode::Instance { id };
                    }
                }
            }
        }
    }
    RunMode::Launcher
}

/// 实例宿主是否以最小化窗口启动（协作子 Agent 的后台运行模式）。
pub fn window_start_minimized() -> bool {
    std::env::args().any(|arg| arg == "--start-minimized")
}

#[cfg(windows)]
pub fn set_app_user_model_id(mode: &RunMode) {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let wide: Vec<u16> = mode
        .app_user_model_id()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

#[cfg(not(windows))]
pub fn set_app_user_model_id(_mode: &RunMode) {}
