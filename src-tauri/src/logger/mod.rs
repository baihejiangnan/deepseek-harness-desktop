use log::{Level, LevelFilter, Metadata, Record};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

/// 日志级别对应数值（数值越大，日志越不敏感/级别越高）
const TRACE: u8 = 0;
const DEBUG: u8 = 1;
const INFO: u8 = 2;
const WARN: u8 = 3;
const ERROR: u8 = 4;
const OFF: u8 = 5;

/// 与 tauri.conf.json 的 identifier 保持一致。logger 初始化早于 AppHandle 可用，
/// 日志文件路径需要自行按 Tauri app_data_dir 的规则（系统数据目录 + identifier）推导。
const APP_IDENTIFIER: &str = "io.github.hairyf.deepseek-harness-desktop";
/// 壳自身日志文件名（与 dsh 核心的 dsh-web.log 放同一 logs 目录）
const LOG_FILE_NAME: &str = "desktop.log";
/// 单文件超过该字节数即滚动，滚动后保留最近 3 个历史文件（desktop.log.1 ~ .3）
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BACKUPS: usize = 3;

/// 将 `log::Level` 转换为内部比较数值
#[inline]
const fn level_to_u8(level: Level) -> u8 {
    match level {
        Level::Trace => TRACE,
        Level::Debug => DEBUG,
        Level::Info => INFO,
        Level::Warn => WARN,
        Level::Error => ERROR,
    }
}

/// 模块级过滤规则
struct FilterRule {
    target: String,
    level: u8,
}

/// 第三方网络库默认降噪规则：即使全局开启 Debug，也不打印 reqwest/hyper 的调试刷屏。
/// 如果用户显式指定了类似 `RUST_LOG=reqwest=debug`，会优先覆盖此处的默认值。
const DEFAULT_NOISY_RULES: &[(&str, u8)] = &[("reqwest", WARN), ("hyper", WARN)];

static FILTER_LEVEL: AtomicU8 = AtomicU8::new(INFO);
static FILTER_RULES: OnceLock<Vec<FilterRule>> = OnceLock::new();

/// 文件 sink（懒初始化）：GUI 模式下 stdout/stderr 被丢弃，必须落盘才能在
/// 桌面端自更新/启动异常后回溯流程（例如「自动重开是否走了安装自愈」）。
/// 首次写日志时才创建目录与文件；创建失败后不再重复尝试，退回纯控制台输出。
static FILE_SINK: Mutex<Option<File>> = Mutex::new(None);
static FILE_SINK_TRIED: AtomicBool = AtomicBool::new(false);

/// 自定义轻量级日志格式化器（控制台 + 文件双写）
struct SimpleLogger;

impl log::Log for SimpleLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let record_level = level_to_u8(metadata.level());
        let current_level = FILTER_LEVEL.load(Ordering::Relaxed);
        let module_path = metadata.target();

        let mut effective_level = current_level;

        if let Some(rules) = FILTER_RULES.get() {
            // 1. 优先匹配显式配置的模块规则（匹配前缀最长者优先）
            if let Some(rule) = most_specific_rule(module_path, rules) {
                effective_level = rule.level;
            } else {
                // 2. 未显式配置时，对指定的第三方高噪库应用默认过滤规则
                for &(target, default_level) in DEFAULT_NOISY_RULES {
                    if module_matches(module_path, target) {
                        effective_level = effective_level.max(default_level);
                        break;
                    }
                }
            }
        }

        record_level >= effective_level
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let module_path = record.module_path().unwrap_or("unknown");

        // 控制台输出保持原有格式（`pnpm tauri dev` 时可见）
        if record.level() == Level::Error {
            let stderr = std::io::stderr();
            let mut handle = stderr.lock();
            let _ = writeln!(handle, "[{}]: {}", module_path, record.args());
            let _ = handle.flush();
        } else {
            let stdout = std::io::stdout();
            let mut handle = stdout.lock();
            let _ = writeln!(handle, "[{}]: {}", module_path, record.args());
            let _ = handle.flush();
        }

        // 文件输出：带时间戳与级别，便于与安装/启动时间线对齐
        Self::write_file(&format!(
            "[{}] [{}] [{}]: {}",
            now_utc(),
            record.level(),
            module_path,
            record.args()
        ));
    }

    fn flush(&self) {
        let _ = std::io::stdout().lock().flush();
        let _ = std::io::stderr().lock().flush();
        if let Ok(mut sink) = FILE_SINK.lock() {
            if let Some(file) = sink.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

impl SimpleLogger {
    /// 追加一行到日志文件；文件超过大小上限时滚动。目录不可用时静默跳过。
    fn write_file(line: &str) {
        if FILE_SINK_TRIED.load(Ordering::Relaxed) {
            return;
        }
        let mut sink = FILE_SINK.lock().unwrap_or_else(|e| e.into_inner());
        if sink.is_none() {
            *sink = open_sink();
            if sink.is_none() {
                FILE_SINK_TRIED.store(true, Ordering::Relaxed);
                return;
            }
        }
        let Some(file) = sink.as_mut() else {
            return;
        };
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
        // 超过上限时滚动：先释放当前句柄（Windows 下文件被占用无法重命名）
        if file.metadata().map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
            *sink = None;
            *sink = rotate_sink();
        }
    }
}

static LOGGER: SimpleLogger = SimpleLogger;

/// 将字符串解析为日志级别，无法识别时返回 `None`
fn parse_level(input: &str) -> Option<u8> {
    match input.trim().to_ascii_lowercase().as_str() {
        "trace" => Some(TRACE),
        "debug" => Some(DEBUG),
        "info" => Some(INFO),
        "warn" => Some(WARN),
        "error" => Some(ERROR),
        "off" => Some(OFF),
        _ => None,
    }
}

/// 判断 `module_path` 是否命中 `target`（如 `reqwest` 可匹配 `reqwest::connect`）
fn module_matches(module_path: &str, target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    module_path == target
        || module_path
            .strip_prefix(target)
            .is_some_and(|rest| rest.starts_with("::"))
}

/// 获取匹配最精确的显式规则（匹配前缀越长，优先级越高）
fn most_specific_rule<'a>(module_path: &str, rules: &'a [FilterRule]) -> Option<&'a FilterRule> {
    rules
        .iter()
        .filter(|rule| module_matches(module_path, &rule.target))
        .max_by_key(|rule| rule.target.len())
}

/// 解析 `RUST_LOG` 指令，支持形如 `debug,reqwest=warn,hyper=warn` 的过滤语法
fn parse_directives(input: &str) -> (Option<u8>, Vec<FilterRule>) {
    let mut global = None;
    let mut rules = Vec::new();

    for part in input.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((target, level_str)) = part.split_once('=') {
            let target = target.trim();
            if let Some(level) = parse_level(level_str) {
                if !target.is_empty() {
                    rules.push(FilterRule {
                        target: target.to_string(),
                        level,
                    });
                }
            }
        } else if let Some(level) = parse_level(part) {
            global = Some(level);
        }
    }

    (global, rules)
}

/// 推导应用数据目录（与 Tauri app_data_dir 的规则一致，此时尚无 AppHandle）：
/// Windows 用 %APPDATA%（Roaming），macOS 用 ~/Library/Application Support，
/// Linux 用 $XDG_DATA_HOME 或 ~/.local/share，再拼上 identifier。
fn app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        return Some(PathBuf::from(appdata).join(APP_IDENTIFIER));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_IDENTIFIER),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| PathBuf::from(h).join(".local/share"))
            })?;
        return Some(base.join(APP_IDENTIFIER));
    }
    #[allow(unreachable_code)]
    None
}

/// 日志文件完整路径：`{app_data_dir}/logs/desktop.log`（与 dsh-web.log 同目录）
fn log_file_path() -> Option<PathBuf> {
    Some(app_data_dir()?.join("logs").join(LOG_FILE_NAME))
}

/// 打开（或创建）日志文件，追加模式
fn open_sink() -> Option<File> {
    let path = log_file_path()?;
    std::fs::create_dir_all(path.parent()?).ok()?;
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// 滚动日志文件：`desktop.log → .1 → .2 → .3`（删除最旧的），再打开新的 desktop.log
fn rotate_sink() -> Option<File> {
    let path = log_file_path()?;
    // 先删除最旧的备份，避免 Windows 下 rename 目标已存在而失败
    let _ = std::fs::remove_file(backup_path(&path, MAX_BACKUPS));
    for i in (1..=MAX_BACKUPS).rev() {
        let src = backup_path(&path, i - 1);
        let dst = backup_path(&path, i);
        if src.exists() {
            let _ = std::fs::rename(&src, &dst);
        }
    }
    open_sink()
}

/// 第 n 个备份的文件名：n=0 为当前文件，n>0 为 `desktop.log.n`
fn backup_path(base: &PathBuf, n: usize) -> PathBuf {
    if n == 0 {
        base.clone()
    } else {
        PathBuf::from(format!("{}.{}", base.display(), n))
    }
}

/// 当前 UTC 时间（`YYYY-MM-DD HH:MM:SS.mmm`），纯算法实现避免引入时间库依赖。
/// 统一用 UTC 而非本地时区：跨平台可移植，且足够用于与安装/启动时间线对齐。
fn now_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86_400;
    let sod = secs % 86_400;

    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}.{:03}Z",
        sod / 3_600,
        (sod % 3_600) / 60,
        sod % 60,
        millis
    )
}

/// 自 UNIX 纪元（1970-01-01）起的日数 → 公历 (年, 月, 日)。Howard Hinnant 算法。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (if m <= 2 { yoe + 1 } else { yoe }) + era * 400;
    (y, m, d)
}

/// 初始化日志系统
///
/// 默认日志级别为 `info`，可以通过环境变量 `RUST_LOG` 进行控制。
/// 例如: `RUST_LOG=debug` 或 `RUST_LOG=debug,reqwest=warn,hyper=warn`
pub fn init() {
    let log_level = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());

    let (global, rules) = parse_directives(&log_level);
    let filter = global.unwrap_or(INFO);

    FILTER_LEVEL.store(filter, Ordering::Relaxed);
    let _ = FILTER_RULES.set(rules);

    log::set_logger(&LOGGER)
        .map(|()| log::set_max_level(LevelFilter::Trace))
        .expect("Failed to initialize logger");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_epoch_and_adjacent() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(31), (1970, 2, 1));
        assert_eq!(civil_from_days(364), (1970, 12, 31));
        assert_eq!(civil_from_days(365), (1971, 1, 1)); // 1970 非闰年
        assert_eq!(civil_from_days(366), (1971, 1, 2));
    }

    #[test]
    fn civil_from_days_leap_year() {
        // 1972-02-29（闰年 2 月最后一天）
        assert_eq!(civil_from_days(789), (1972, 2, 29));
        assert_eq!(civil_from_days(790), (1972, 3, 1));
    }

    #[test]
    fn now_utc_format() {
        let s = now_utc();
        let ok = s.len() >= 20
            && s.ends_with('Z')
            && s.as_bytes().get(4) == Some(&b'-')
            && s.as_bytes().get(7) == Some(&b'-')
            && s.as_bytes().get(10) == Some(&b' ')
            && s.as_bytes().get(13) == Some(&b':')
            && s.as_bytes().get(16) == Some(&b':')
            && s.as_bytes().get(19) == Some(&b'.');
        assert!(ok, "unexpected timestamp format: {s}");
    }
}
