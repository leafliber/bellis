//! 实时核启动参数、环境变量凭据与输入模式门禁。
//!
//! 生产二进制只保留两种运行模式：
//! - 只读采集模式（未提供许可源）：不装低层钩子、不发键鼠输入；
//! - 真实输入模式（提供唯一许可源——环境变量直接凭据或 Windows 凭据管理器目标）：启用真实
//!   `SendInput` + 低层键鼠钩子 + 物理残留核验 + 统一许可控制 RPC。

use std::time::Duration;

use bellis_channel::ChannelCredentials;

use super::cred::is_session_id;
use crate::input::Combo;

/// 主控核连接的管道地址。
pub const ENV_CHANNEL_PATH: &str = "BELLIS_CHANNEL_PATH";
/// 主控核连接的会话密钥（base64url 无填充编码）。
pub const ENV_CHANNEL_KEY: &str = "BELLIS_CHANNEL_KEY";
/// 主控核连接的角色名（缺省 `"realtime-core.core"`）。
pub const ENV_ROLE: &str = "BELLIS_ROLE";
/// 统一许可控制连接的管道地址（可选；与 `--permit-cred` 二选一）。
pub const ENV_PERMIT_PATH: &str = "BELLIS_PERMIT_PATH";
/// 统一许可控制连接的会话密钥（base64url 无填充编码）。
pub const ENV_PERMIT_KEY: &str = "BELLIS_PERMIT_KEY";
/// 统一许可控制连接的角色名（缺省 `"realtime-core.permit"`）。
pub const ENV_PERMIT_ROLE: &str = "BELLIS_PERMIT_ROLE";

pub const DEFAULT_CORE_ROLE: &str = "realtime-core.core";
pub const DEFAULT_PERMIT_ROLE: &str = "realtime-core.permit";

/// 心跳超时的缺省值（主控以 100ms 周期发心跳，连丢约 5 次超时）。
pub const DEFAULT_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(500);
/// `health` 上报的缺省周期。
pub const DEFAULT_HEALTH_INTERVAL: Duration = Duration::from_millis(1000);
/// 动作允许的帧龄缺省值。
pub const DEFAULT_MAX_FRAME_AGE: Duration = Duration::from_millis(500);
/// `core.hello` 握手超时。
pub const HELLO_TIMEOUT: Duration = Duration::from_millis(2000);

/// 命令行用法说明。
pub const USAGE: &str = "usage: realtime-core [--heartbeat-timeout-ms <ms>] \
                         [--health-interval-ms <ms>] [--max-frame-age-ms <ms>] \
                         [--core-cred <target>] [--core-session-id <id>] \
                         [--permit-cred <target>] [--permit-session-id <id>] \
                         [--emergency-hotkey <combo>]";

/// 命令行参数。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub heartbeat_timeout: Duration,
    pub health_interval: Duration,
    pub max_frame_age: Duration,
    pub emergency_hotkey: Option<Combo>,
    pub core_cred: Option<String>,
    pub core_session_id: Option<String>,
    pub permit_cred: Option<String>,
    pub permit_session_id: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            heartbeat_timeout: DEFAULT_HEARTBEAT_TIMEOUT,
            health_interval: DEFAULT_HEALTH_INTERVAL,
            max_frame_age: DEFAULT_MAX_FRAME_AGE,
            emergency_hotkey: None,
            core_cred: None,
            core_session_id: None,
            permit_cred: None,
            permit_session_id: None,
        }
    }
}

impl Options {
    /// 解析命令行参数（不含程序名）。
    ///
    /// # Errors
    ///
    /// 未知参数、缺少取值、重复取值、时限非正整数或热键/会话号非法时返回说明。
    pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut options = Self::default();
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let need = || format!("{arg} needs a value");
            match arg.as_str() {
                "--emergency-hotkey" => {
                    let combo = args.next().ok_or_else(need)?;
                    options.emergency_hotkey = Some(Combo::parse(&combo)?);
                }
                "--core-cred" | "--permit-cred" => {
                    let target = args.next().ok_or_else(need)?;
                    if target.is_empty() || target.contains('\0') {
                        return Err(format!("{arg} needs a non-empty target name"));
                    }
                    let slot = if arg == "--core-cred" {
                        &mut options.core_cred
                    } else {
                        &mut options.permit_cred
                    };
                    if slot.replace(target).is_some() {
                        return Err(format!("{arg} can only be specified once"));
                    }
                }
                "--core-session-id" | "--permit-session-id" => {
                    let id = args.next().ok_or_else(need)?;
                    if !is_session_id(&id) {
                        return Err(format!("{arg} needs a valid sessionId"));
                    }
                    let slot = if arg == "--core-session-id" {
                        &mut options.core_session_id
                    } else {
                        &mut options.permit_session_id
                    };
                    if slot.replace(id).is_some() {
                        return Err(format!("{arg} can only be specified once"));
                    }
                }
                "--heartbeat-timeout-ms" | "--health-interval-ms" | "--max-frame-age-ms" => {
                    let raw = args.next().ok_or_else(need)?;
                    let duration = match raw.parse::<u64>() {
                        Ok(millis) if millis > 0 => Duration::from_millis(millis),
                        _ => return Err(format!("{arg} must be a positive integer, got {raw:?}")),
                    };
                    match arg.as_str() {
                        "--heartbeat-timeout-ms" => options.heartbeat_timeout = duration,
                        "--health-interval-ms" => options.health_interval = duration,
                        "--max-frame-age-ms" => options.max_frame_age = duration,
                        _ => unreachable!(),
                    }
                }
                _ => return Err(format!("unknown argument {arg:?}")),
            }
        }
        Ok(options)
    }
}

/// 从环境变量取得的连接凭据（`Debug` 隐去全部密钥）。
#[derive(Debug)]
pub struct Launch {
    pub credentials: Option<ChannelCredentials>,
    pub role: String,
    pub permit: Option<ChannelCredentials>,
    pub permit_role: String,
}

impl Launch {
    /// 从环境变量读取连接信息（`get` 可在测试中替换）。
    ///
    /// # Errors
    ///
    /// 地址与密钥只给其一或密钥格式错误时返回说明（绝不含密钥明文）。
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let optional = |name: &str| get(name).filter(|value| !value.is_empty());
        let pair = |path_var: &str, key_var: &str| match (optional(path_var), optional(key_var)) {
            (None, None) => Ok(None),
            (Some(path), Some(key)) => ChannelCredentials::decode(path, &key)
                .map(Some)
                .map_err(|error| format!("{key_var} is invalid: {}", error.code().as_str())),
            _ => Err(format!("give both {path_var} and {key_var}, or neither")),
        };
        let credentials = pair(ENV_CHANNEL_PATH, ENV_CHANNEL_KEY)?;
        let role = optional(ENV_ROLE).unwrap_or_else(|| DEFAULT_CORE_ROLE.to_owned());
        let permit = pair(ENV_PERMIT_PATH, ENV_PERMIT_KEY)?;
        let permit_role =
            optional(ENV_PERMIT_ROLE).unwrap_or_else(|| DEFAULT_PERMIT_ROLE.to_owned());
        Ok(Self {
            credentials,
            role,
            permit,
            permit_role,
        })
    }

    /// 校验并选出唯一核通道凭据源（环境变量直传或 Windows 凭据管理器）。
    ///
    /// # Errors
    ///
    /// 两者同时提供、两者均未提供或单独指定 `--core-session-id` 时失败。
    pub fn select_core(&mut self, options: &Options) -> Result<ChannelSource, String> {
        if options.core_session_id.is_some() && options.core_cred.is_none() {
            return Err("--core-session-id requires --core-cred".into());
        }
        if self.credentials.is_some() && options.core_cred.is_some() {
            return Err(format!(
                "specify either {ENV_CHANNEL_PATH}/{ENV_CHANNEL_KEY} or --core-cred, not both"
            ));
        }
        match (self.credentials.take(), options.core_cred.as_ref()) {
            (Some(credentials), None) => Ok(ChannelSource::Direct(credentials)),
            (None, Some(target)) => Ok(ChannelSource::CredMan {
                target: target.clone(),
                expected_session_id: options.core_session_id.clone(),
            }),
            (None, None) => Err(format!(
                "specify {ENV_CHANNEL_PATH}/{ENV_CHANNEL_KEY} or --core-cred"
            )),
            (Some(_), Some(_)) => unreachable!(),
        }
    }

    /// 校验并选出唯一输入模式（只读采集或真实输入 + 单一许可源）。
    ///
    /// # Errors
    ///
    /// 同时指定两处许可源、未启用输入却指定 `--emergency-hotkey` 或单独指定 `--permit-session-id` 时失败。
    pub fn select_input(&mut self, options: &Options) -> Result<InputMode, String> {
        if options.permit_session_id.is_some() && options.permit_cred.is_none() {
            return Err("--permit-session-id requires --permit-cred".into());
        }
        if self.permit.is_some() && options.permit_cred.is_some() {
            return Err(format!(
                "specify either {ENV_PERMIT_PATH}/{ENV_PERMIT_KEY} or --permit-cred, not both"
            ));
        }
        let source = match (self.permit.take(), options.permit_cred.as_ref()) {
            (Some(credentials), None) => Some(ChannelSource::Direct(credentials)),
            (None, Some(target)) => Some(ChannelSource::CredMan {
                target: target.clone(),
                expected_session_id: options.permit_session_id.clone(),
            }),
            (None, None) => None,
            (Some(_), Some(_)) => unreachable!(),
        };
        match source {
            None => {
                if options.emergency_hotkey.is_some() {
                    return Err("--emergency-hotkey requires a permit source".into());
                }
                Ok(InputMode::ReadOnly)
            }
            Some(source) => Ok(InputMode::Real {
                source,
                role: self.permit_role.clone(),
                emergency: options
                    .emergency_hotkey
                    .clone()
                    .unwrap_or_else(Combo::default_hotkey),
            }),
        }
    }
}

/// 通道凭据来源（核连接与统一许可控制连接共用）。
#[derive(Clone, Debug)]
pub enum ChannelSource {
    Direct(ChannelCredentials),
    CredMan {
        target: String,
        expected_session_id: Option<String>,
    },
}

impl ChannelSource {
    /// 环境变量子进程模式使用 stdin EOF 生命线；计划任务凭据模式仅以核管道断连作生命线。
    #[must_use]
    pub const fn uses_stdin_lifeline(&self) -> bool {
        matches!(self, Self::Direct(_))
    }
}

/// 统一许可控制连接的凭据来源（最终均走同一套 5 方法 RPC）。
pub type PermitSource = ChannelSource;

/// 已过门禁的输入模式。
#[derive(Debug)]
pub enum InputMode {
    /// 只读采集模式：不安装钩子、不发键鼠输入。
    ReadOnly,
    /// 真实输入模式：Windows `SendInput` + 低层键鼠钩子 + 物理残留核验 + 统一许可控制 RPC。
    Real {
        source: PermitSource,
        role: String,
        emergency: Combo,
    },
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use bellis_channel::{create_session_key, encode_session_key};

    use super::{
        ChannelSource, DEFAULT_CORE_ROLE, DEFAULT_PERMIT_ROLE, ENV_CHANNEL_KEY, ENV_CHANNEL_PATH,
        ENV_PERMIT_KEY, ENV_PERMIT_PATH, ENV_ROLE, InputMode, Launch, Options, PermitSource,
    };

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|&s| s.to_owned()).collect()
    }

    #[test]
    fn parses_options_and_rejects_invalid_arguments() {
        let defaults = Options::parse(args(&[])).unwrap();
        assert_eq!(defaults, Options::default());

        let parsed = Options::parse(args(&[
            "--heartbeat-timeout-ms",
            "300",
            "--health-interval-ms",
            "50",
            "--max-frame-age-ms",
            "120",
            "--core-cred",
            "core.bellis",
            "--core-session-id",
            "c01",
            "--permit-cred",
            "session.bellis",
            "--permit-session-id",
            "abc01",
            "--emergency-hotkey",
            "ctrl+alt+end",
        ]))
        .unwrap();
        assert_eq!(parsed.heartbeat_timeout, Duration::from_millis(300));
        assert_eq!(parsed.health_interval, Duration::from_millis(50));
        assert_eq!(parsed.max_frame_age, Duration::from_millis(120));
        assert_eq!(parsed.core_cred.as_deref(), Some("core.bellis"));
        assert_eq!(parsed.core_session_id.as_deref(), Some("c01"));
        assert_eq!(parsed.permit_cred.as_deref(), Some("session.bellis"));
        assert_eq!(parsed.permit_session_id.as_deref(), Some("abc01"));
        assert!(parsed.emergency_hotkey.is_some());

        for bad in [
            &["--input-backend", "fake"][..],
            &["--heartbeat-timeout-ms", "0"],
            &["--health-interval-ms", "-1"],
            &["--max-frame-age-ms"],
            &["--core-cred", ""],
            &["--core-cred", "a", "--core-cred", "b"],
            &["--core-session-id", "BAD"],
            &["--permit-cred", ""],
            &["--permit-cred", "a", "--permit-cred", "b"],
            &["--permit-session-id", "BAD"],
            &["--emergency-hotkey", "ctrl+shift"],
        ] {
            assert!(Options::parse(args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn enforces_single_core_and_permit_sources_and_never_leaks_keys() {
        let core_key = encode_session_key(&create_session_key());
        let permit_key = encode_session_key(&create_session_key());

        let mut empty = Launch::from_env(|_| None).unwrap();
        assert!(empty.select_core(&Options::default()).is_err());
        let core_sess_only = Options::parse(args(&["--core-session-id", "c01"])).unwrap();
        assert!(empty.select_core(&core_sess_only).is_err());
        let core_cred_opts = Options::parse(args(&[
            "--core-cred",
            "core.bellis",
            "--core-session-id",
            "c01",
        ]))
        .unwrap();
        let selected_core = empty.select_core(&core_cred_opts).unwrap();
        assert!(!selected_core.uses_stdin_lifeline());
        assert!(matches!(
            selected_core,
            ChannelSource::CredMan { ref target, ref expected_session_id }
                if target == "core.bellis" && expected_session_id.as_deref() == Some("c01")
        ));

        let mut env = HashMap::from([(ENV_CHANNEL_PATH, r"\\.\pipe\core".to_owned())]);
        assert!(Launch::from_env(|k| env.get(k).cloned()).is_err());
        env.insert(ENV_CHANNEL_KEY, core_key.clone());

        let mut launch = Launch::from_env(|k| env.get(k).cloned()).unwrap();
        assert_eq!(launch.role, DEFAULT_CORE_ROLE);
        assert_eq!(launch.permit_role, DEFAULT_PERMIT_ROLE);
        assert!(!format!("{launch:?}").contains(&core_key));
        assert!(launch.select_core(&core_cred_opts).is_err());
        let direct_core = launch.select_core(&Options::default()).unwrap();
        assert!(direct_core.uses_stdin_lifeline());
        assert!(matches!(
            direct_core,
            ChannelSource::Direct(ref creds) if creds.path == r"\\.\pipe\core"
        ));
        assert!(matches!(
            launch.select_input(&Options::default()).unwrap(),
            InputMode::ReadOnly
        ));

        let hotkey_only = Options::parse(args(&["--emergency-hotkey", "ctrl+shift+f12"])).unwrap();
        assert!(launch.select_input(&hotkey_only).is_err());

        let sess_only = Options::parse(args(&["--permit-session-id", "a01"])).unwrap();
        assert!(launch.select_input(&sess_only).is_err());

        let cred_opts = Options::parse(args(&[
            "--permit-cred",
            "session.bellis",
            "--permit-session-id",
            "a01",
        ]))
        .unwrap();
        assert!(matches!(
            launch.select_input(&cred_opts).unwrap(),
            InputMode::Real {
                source: PermitSource::CredMan { ref target, ref expected_session_id },
                ..
            } if target == "session.bellis" && expected_session_id.as_deref() == Some("a01")
        ));

        env.insert(ENV_ROLE, "custom.core".into());
        env.insert(ENV_PERMIT_PATH, r"\\.\pipe\permit".into());
        assert!(Launch::from_env(|k| env.get(k).cloned()).is_err());
        env.insert(ENV_PERMIT_KEY, permit_key.clone());
        let mut launch = Launch::from_env(|k| env.get(k).cloned()).unwrap();
        assert_eq!(launch.role, "custom.core");
        assert!(!format!("{launch:?}").contains(&permit_key));
        assert!(launch.select_input(&cred_opts).is_err());
        assert!(matches!(
            launch.select_input(&Options::default()).unwrap(),
            InputMode::Real {
                source: PermitSource::Direct(ref creds),
                ..
            } if creds.path == r"\\.\pipe\permit"
        ));
    }
}
