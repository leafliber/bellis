# Windows 平台

Windows 11 x64 是唯一的生产平台。P0 在 macOS 验收，P1 起只认 Windows；三平台 CI 始终运行完整检查并必须通过，但 CI 通过不构成阶段验收（D-11）。本文记录写代码时必须遵守的 Windows 事实与约束。

## 进程

- **宿主运行在用户的交互会话里。** 不做成 Windows 服务，由启动器拉起（R-23）：服务运行在 Session 0，不能和桌面交互，而采集、输入、OBS、VTube Studio 都需要交互桌面。[来源](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)
- **启动子进程**：一律 `spawn`，不用 `shell`，不用 `detached`，设 `windowsHide`，显式传入环境变量。
- **没有 POSIX 信号。** Node 在 Windows 上对子进程调用 `kill()`，无论传什么信号都是强制终止、没有宽限期；SIGTERM 处理函数不会被触发。[来源](https://nodejs.org/api/child_process.html#subprocesskillsignal) 停止流程（R-06）：
  1. 发 RPC `shutdown`；
  2. 关闭子进程的 stdin，子进程读到 EOF 后自行退出；
  3. 超过截止时间再 `kill()`。
- **孙进程要自己管。** libuv 把 Node 和它的直接子进程放进一个“父进程退出即杀死”的 Job，但孙进程会脱离这个 Job。所以 sidecar 必须用 Job Object（KILL_ON_JOB_CLOSE）管住自己派生的进程。[来源](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)
- **环境变量**：键不区分大小写；不要删掉 `SYSTEMROOT` 等系统必需变量，否则 Winsock 初始化会失败。

## 本机通信

- **命名管道**（D-12）：路径形如 `\\.\pipe\bellis-<会话>-<128 位随机数>`，每次启动重新生成；子进程经环境变量获得，非子进程从 SecretStore 读取（R-23）；用会话密钥做 HMAC 双向认证（R-05）。
- **宿主永远做服务端。** 宿主不提权；需要提权的 Game Runtime 做客户端。
- **认证先于数据。** libuv 创建管道时使用默认安全描述符，Everyone 和匿名用户有读权限；管道命名空间全机共享，任何本地用户都可能抢先注册同名管道。所以双方先完成双向认证，认证前不发送任何数据；帧长有上限，每一步有超时。[来源](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- 不用 `readableAll`、`writableAll`，它们只会给 Everyone 加权限。
- 监听时收到 `EADDRINUSE`，按“可能被抢注”告警处理，不要用同名重试。客户端握手以 `auth-failed` 失败时同样告警。
- **已知问题（S-03）**：libuv 建的管道不带 `PIPE_REJECT_REMOTE_CLIENTS`，Node 也没有设置它的接口，所以经 SMB 的远程客户端能连上（本机回环已实测，跨机 PENDING）。远程客户端和其他用户只有读权限：发不出 hello，拿不到任何数据，但能占用未认证的握手名额（上限 16 个，各自 2s 超时）。目前不另做处理，依靠握手认证，以及防火墙不放行入站 SMB。
- 同一用户的进程能给宿主的管道再加实例；客户端落到这些实例上会以 `auth-failed` 失败，宿主侧察觉不到。同一用户的恶意进程不在威胁模型内（D-12）。
- 游戏画面帧不走管道（1080p 30fps 约 240MB/s），在 Game Runtime 内部处理。
- 开发机（macOS/Linux）用 UDS，走同一抽象。

## 凭据

统一的 SecretStore 接口（D-28）：小令牌存凭据管理器，大块数据用 DPAPI 加密成文件（出现超出凭据管理器单条上限的条目时再实现，R-16）；macOS 用 Keychain。DPAPI 能防其他用户，不能防同一用户下的其他程序，与威胁模型一致。[来源](https://www.electronjs.org/docs/latest/api/safe-storage)

## 定时与调度

- libuv 在 Windows 上不调用 `timeBeginPeriod`，Node 定时器的粒度约为系统默认的 15.6ms（S-05 已在 Windows 11 真机上确认）：短于一个时钟周期的 `setTimeout` 也要等满一个周期，略长于整周期的要等两个。不要依赖小于 16ms 的 `setTimeout` 精度，调度一律用单调时钟加截止时间。事件循环延迟的测量值同样包含这一粒度，设异常阈值时要计入。
- 音频播放时钟交给 Stage 的 AudioWorklet 和 OBS，宿主不逐样本定时。
- Win11 起，进程的窗口被完全遮挡或最小化时，系统不再保证高分辨率定时器；后台进程还可能被系统归为 EcoQoS 降低调度优先级。[来源](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod) 对 OBS 浏览器源音频和 sidecar 推理的影响由探针 S-01、S-05 实测。
- 不使用 REALTIME 优先级类，它可能让鼠标和磁盘缓存失去响应。

## GPU

- Windows 不支持 CUDA MPS，游戏、OBS 编码和多个模型进程只能在同一张卡上分时争用。[来源](https://docs.nvidia.com/deploy/mps/latest/when-to-use-mps.html)
- 据 OBS 32.2 发布说明，NVENC 要求 NVIDIA 驱动 ≥570。[来源](https://github.com/obsproject/obs-studio/releases)
- 硬件加速 GPU 调度（HAGS）可能引起 OBS 编码问题；显存不足时 CUDA 可能回落到系统内存而明显变慢，可设为不回落。
- 先单机部署，在真机上测清争用（探针 S-02）后再定是否加推理机（D-22）。

## OBS

- 基线版本 32.2.x（D-24）。据 33.0.0-rc1 发布说明，33 将浏览器内核从 CEF 127 升到 150，正式发布并复测后再迁移。[来源](https://github.com/obsproject/obs-studio/releases/tag/33.0.0-rc1)
- 控制走 obs-websocket 5：认证、`RequestBatch`（可串行执行一组请求）、按需订阅高频事件。
- 浏览器源设置见 [Stage](../modules/stage.md)。

## 采集与输入（Game Runtime 侧）

这些属于 Game Runtime，列在这里是因为它们约束 Bellis 的部署：

- 游戏以管理员权限运行时，非提权进程的 `SendInput` 会被系统静默丢弃，输入代理必须同样提权。[来源](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- 注入的键鼠事件带有“已注入”标志，可被识别。
- ViGEmBus 虚拟手柄已停止维护，不依赖它。
- Unity 的 `runInBackground` 默认关闭，失焦即暂停；新版输入系统在桌面平台不在后台接收键盘输入。所以游戏窗口必须保持在前台。[来源](https://docs.unity3d.com/ScriptReference/Application-runInBackground.html)

## 路径与文件

- 路径比较前先规范化（`fs.realpathSync.native`）；Windows 路径不区分大小写，临时目录常是 8.3 短名。
- 不写死 `/tmp` 或任何 POSIX 路径，用 `os.tmpdir()` 与 `path` 模块。
- 不依赖文件权限位、uid、符号链接语义做安全判断。
- 仓库用 `.gitattributes` 统一 LF 换行。

## 打包

暂不定（R-22）。已知约束：Node 单可执行文件功能仍在活跃开发；个人开发者的代码签名渠道受地区限制，签名后的 SmartScreen 信誉需要逐步积累。

## CI

- 每次提交都在 Windows、macOS、Linux 上运行完整检查。
- 测试里的管道名也随机生成。
- 至少一个用例：杀掉宿主后，断言其子进程已退出。
