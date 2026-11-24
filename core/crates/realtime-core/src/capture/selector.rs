//! 窗口识别条件：按进程映像文件名、窗口类名与标题精确匹配可见顶层窗口。

use std::fmt;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowSelector {
    /// 进程映像文件名（如 `StarRail.exe`），不含目录，不区分大小写。
    pub process_name: Option<String>,
    /// 窗口类名，精确匹配。
    pub class_name: Option<String>,
    /// 窗口标题，精确匹配。
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowInfo {
    pub process_image: Option<String>,
    pub class_name: String,
    pub title: String,
}

impl WindowSelector {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.process_name.is_none() && self.class_name.is_none() && self.title.is_none()
    }

    #[must_use]
    pub fn matches(&self, window: &WindowInfo) -> bool {
        if self.is_empty() {
            return false;
        }
        let process_ok = self.process_name.as_deref().is_none_or(|wanted| {
            window
                .process_image
                .as_deref()
                .is_some_and(|image| same_file_name(file_name(image), wanted))
        });
        let class_ok = self
            .class_name
            .as_deref()
            .is_none_or(|wanted| window.class_name == wanted);
        let title_ok = self
            .title
            .as_deref()
            .is_none_or(|wanted| window.title == wanted);
        process_ok && class_ok && title_ok
    }
}

impl fmt::Display for WindowSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let parts = [
            ("process", &self.process_name),
            ("class", &self.class_name),
            ("title", &self.title),
        ];
        let mut first = true;
        for (name, value) in parts {
            if let Some(value) = value {
                if !first {
                    f.write_str(" and ")?;
                }
                write!(f, "{name} {value:?}")?;
                first = false;
            }
        }
        if first {
            f.write_str("an empty selector")?;
        }
        Ok(())
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn same_file_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{WindowInfo, WindowSelector};

    #[test]
    fn matches_case_insensitive_process_and_exact_class_title() {
        let window = WindowInfo {
            process_image: Some(r"C:\Games\StarRail.EXE".into()),
            class_name: "UnityWndClass".into(),
            title: "崩坏：星穹铁道".into(),
        };
        let sel = WindowSelector {
            process_name: Some("starrail.exe".into()),
            class_name: Some("UnityWndClass".into()),
            title: Some("崩坏：星穹铁道".into()),
        };
        assert!(sel.matches(&window));
        assert!(!WindowSelector::default().matches(&window));
        let wrong_class = WindowSelector {
            class_name: Some("unitywndclass".into()),
            ..sel
        };
        assert!(!wrong_class.matches(&window));
    }
}
