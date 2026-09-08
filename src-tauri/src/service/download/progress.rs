use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Runtime, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub title: String,
    pub detail: String,
    pub log: String,
    pub r#type: String,
    pub percentage: f64,
    // 子任务进度
    pub progress: f64,
}

pub struct ProgressTracker<'a, R: Runtime> {
    window: &'a WebviewWindow<R>,
    total_phases: usize,
    current_phase: usize,
    current_title: String,
    current_type: String,
    last_emit_time: Mutex<Option<Instant>>,
}

impl<'a, R: Runtime> ProgressTracker<'a, R> {
    pub fn new(window: &'a WebviewWindow<R>, task_count: usize) -> Self {
        Self {
            window,
            total_phases: task_count,
            current_phase: 0,
            current_title: crate::config::i18n::t("install.preparing"),
            current_type: String::from(""),
            last_emit_time: Mutex::new(None),
        }
    }

    /// 切换阶段，并设置大标题
    pub fn start_phase(&mut self, r#type: &str, title: &str) {
        self.current_title = title.to_string();
        self.current_type = r#type.to_string();
    }

    /// 完成一个阶段
    pub fn end_phase(&mut self) {
        if self.current_phase < self.total_phases {
            self.current_phase += 1;
        }
    }

    /// stage_pct: 当前子任务的进度 (0.0 - 100.0)
    /// detail: 用于显示的主要信息 (如 "已下载 xx MB / xx MB" 或 "已解压 30%")
    /// log: 用于在 log 窗口显示的文字 (如 "Download http://..." 或 "Extract xx/xx/xx")
    pub fn update(&self, stage_pct: f64, detail: String, log: String) {
        let now = Instant::now();
        // 中毒安全：若 install 过程中已有 panic 污染该锁，后续不应再次 panic
        // 导致整个桌面进程退出，这里忽略中毒状态继续读取旧值。
        let mut last_emit = self
            .last_emit_time
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        // 节流处理：如果距离上次发送不足 50ms，则跳过。
        // 完成事件（100%）不得丢弃：前端靠它结束环境准备阶段。
        if stage_pct < 100.0 {
            if let Some(last_time) = *last_emit {
                if now.duration_since(last_time) < Duration::from_millis(50) {
                    return;
                }
            }
        }

        *last_emit = Some(now);

        let global_pct = weighted_percentage(self.current_phase, self.total_phases, stage_pct);

        let _ = self.window.emit(
            "install-progress",
            ProgressPayload {
                title: self.current_title.clone(),
                r#type: self.current_type.clone(),
                percentage: global_pct,
                progress: stage_pct,
                detail,
                log,
            },
        );
    }

    /// 跳过指定数量的阶段
    pub fn skip_phases(&mut self, count: usize) {
        self.current_phase = (self.current_phase + count).min(self.total_phases);
    }
}

/// 阶段加权总进度，收敛到 0–100。
///
/// `stage_pct < 0` 表示本阶段总量不可测量（如 TGZ 解压），此时只保留已完成阶段的
/// 底数，不把负值计入加权。`total_phases` 为 0 时权重会是无穷大，兜住以免算出
/// NaN/inf。done 阶段 `current_phase` 已等于 `total_phases`，叠加后可能略超 100。
fn weighted_percentage(current_phase: usize, total_phases: usize, stage_pct: f64) -> f64 {
    let phase_weight = 100.0 / total_phases.max(1) as f64;
    let stage_contribution = if stage_pct < 0.0 {
        0.0
    } else {
        stage_pct * phase_weight / 100.0
    };
    ((current_phase as f64 * phase_weight) + stage_contribution).clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::weighted_percentage;

    #[test]
    fn final_phase_never_overshoots_one_hundred() {
        // 最后一个阶段再叠加越界的子进度也不能超过 100。
        assert_eq!(weighted_percentage(3, 3, 100.0), 100.0);
        assert_eq!(weighted_percentage(3, 3, 250.0), 100.0);
    }

    #[test]
    fn out_of_range_stage_is_clamped_into_the_band() {
        assert_eq!(weighted_percentage(0, 4, 140.0), 35.0);
        assert_eq!(weighted_percentage(0, 4, -0.5), 0.0);
    }

    #[test]
    fn zero_phases_yields_a_finite_percentage() {
        let value = weighted_percentage(0, 0, 100.0);
        assert!(value.is_finite(), "expected finite, got {value}");
        assert!((0.0..=100.0).contains(&value));
    }

    #[test]
    fn unmeasurable_stage_keeps_only_the_completed_base() {
        // -1 必须原样透出给前端用来判定不确定态，同时总进度停在已完成阶段底数上。
        assert_eq!(weighted_percentage(2, 4, -1.0), 50.0);
        assert_eq!(weighted_percentage(0, 4, -1.0), 0.0);
    }

    #[test]
    fn skipped_phases_advance_the_base() {
        assert_eq!(weighted_percentage(1, 4, 0.0), 25.0);
        assert_eq!(weighted_percentage(4, 4, 0.0), 100.0);
    }
}
