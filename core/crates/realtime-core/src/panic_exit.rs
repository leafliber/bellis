//! panic 即退出：任何线程 panic 都在打印信息后退出整个进程，避免残缺状态继续运行。

use std::panic;
use std::process;

/// panic 退出时的退出码，与 Rust 主线程 panic 的缺省退出码相同。
pub const PANIC_EXIT_CODE: i32 = 101;

/// 装上 panic 钩子：任何线程 panic 都在打印信息后退出整个进程。进程启动时调用一次。
pub fn install_panic_exit() {
    let default = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        default(info);
        log!("panic; exiting with code {PANIC_EXIT_CODE}");
        process::exit(PANIC_EXIT_CODE);
    }));
}
