//! 实时核进程入口：按参数列表启动、以 stdin EOF 为生命线、释放全部输入后退出。
//!
//! 退出码：0 表示释放全部输入后正常结束（`shutdown`、核连接断开或 stdin EOF），
//! 1 表示无法建立会话或物理释放未通过核验，2 表示参数/门禁不合法，101 表示 panic。

use std::fmt;
use std::io::{self, Write as _};
use std::process::ExitCode;

use realtime_core::capture::dpi::declare_per_monitor_aware_v2;
use realtime_core::session::config::{Launch, Options, USAGE};
use realtime_core::{install_panic_exit, session};

fn say(message: fmt::Arguments<'_>) {
    let _ = writeln!(io::stderr(), "realtime-core: {message}");
}

fn main() -> ExitCode {
    install_panic_exit();
    if let Err(error) = declare_per_monitor_aware_v2() {
        say(format_args!(
            "failed to declare per-monitor DPI awareness v2: {error}"
        ));
        return ExitCode::FAILURE;
    }
    let options = match Options::parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            say(format_args!("{error}\n{USAGE}"));
            return ExitCode::from(2);
        }
    };
    let mut launch = match Launch::from_env(|name| std::env::var(name).ok()) {
        Ok(launch) => launch,
        Err(error) => {
            say(format_args!("{error}"));
            return ExitCode::FAILURE;
        }
    };
    let input = match launch.select_input(&options) {
        Ok(input) => input,
        Err(error) => {
            say(format_args!("{error}\n{USAGE}"));
            return ExitCode::from(2);
        }
    };
    match session::run(&options, &launch, input, io::stdin()) {
        Ok(_) => ExitCode::SUCCESS,
        Err(error) => {
            say(format_args!("{error}"));
            ExitCode::FAILURE
        }
    }
}
