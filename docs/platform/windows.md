# Windows 平台

Windows 11 x64 是唯一的生产平台。P0 在 macOS 验收，P1 起只认 Windows；三平台 CI 始终运行完整检查并必须通过，但 CI 通过不构成阶段验收（D-11）。本文记录写代码时必须遵守的 Windows 事实与约束。

## 进程

- **宿主运行在用户的交互会话里。** 不做成 Windows 服务，由启动器拉起（R-23）：服务运行在 Session 0，不能和桌面交互，而采集、输入、OBS、VTube Studio 都需要交互桌面。[来源](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)
- **启动子进程**：一律 `spawn`，不用 `shell`，不用 `detached`，设 `windowsHide`，显式传入环境变量。
- **没有 POSIX 信号。** Node 在 Windows 上对子进程调用 `kill()`，无论传什么信号都是强制终止、没有宽限期；SIGTERM 处理函数不会被触发。[来源](https://nodejs.org/api/child_process.html#subprocesskillsignal) 停止流程（R-06）：
  1. 发 RPC `shutdown`；
  2. 关闭子进程的 stdin，子进程读到 EOF 后自行退出；
  3. 超过截止时间再 `kill()`。
- **孙进程要自己管。** libuv 把 Node 和它的直接子进程放进一个“父进程退出即杀死”的 Job，但孙进程会脱离这个 Job。所以 sidecar 必须用 Job Object（KILL_ON_JOB_CLOSE）管住自己派生的进程，做法见[插件内核](../modules/plugin-kernel.md#sidecar-代理)。[来源](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)
- **stdin 生命线不能挂着同步读。** 宿主给子进程的 stdin 管道不支持重叠 I/O，只能在线程里同步读；而同一文件对象上的同步 I/O 是串行的，挂着的 ReadFile 会让其它线程对 stdin 的查询（例如查询读写位置）一直等下去。本机实测：sidecar 的生命线线程挂着读时，`import torch` 在加载原生库时卡死。所以 Windows 上 sidecar 用 PeekNamedPipe 轮询，管道断开即视为 EOF。
- **Python sidecar 不经 `uv run` 启动。** 本机实测（uv 0.11.11）：强制终止 `uv run` 时，它经虚拟环境的 `python.exe` 启动的解释器不随之退出；虚拟环境的 `python.exe` 是个启动器，被强制终止时它启动的解释器随之退出。所以宿主直接启动虚拟环境里的 `python.exe`；`uv run` 每次启动还会按锁文件同步环境，也不适合在直播中拉起进程。
- **环境变量**：键不区分大小写；不要删掉 `SYSTEMROOT` 等系统必需变量，否则 Winsock 初始化会失败。

## 登录时运行

启动器由“登录时运行”的计划任务拉起（R-23）。维护者在自己的终端里用 `pnpm autostart register [配置文件]` 注册（缺省 `config/live.json`，覆盖同名任务），`pnpm autostart unregister` 注销，`pnpm autostart status` 读回核对；其它平台报告 unsupported。

- **注册方式（R-26）。** 以 `spawn` 调用 `%SystemRoot%\System32\schtasks.exe`，不经 shell、不按 PATH 查找：`/Create /TN Bellis /XML <文件> /F` 注册，`/Delete /TN Bellis /F` 注销，`/Query /TN Bellis /XML` 读回。schtasks 的输出随系统语言本地化，成败只看退出码。任务名是根目录下的 `Bellis`，不建任务文件夹，注销后不留空文件夹。
- **任务 XML** 由代码生成（Task Scheduler 1.2 schema），写进系统临时目录，用完即删：
  - 唯一的触发器是登录触发器，`UserId` 为当前用户 `USERDOMAIN\用户名`；取不到时报错，不放宽成任意用户。
  - 运行身份同为当前用户，交互令牌（`InteractiveToken`：只在该用户登录后运行，进程在其桌面上）、最低权限（`LeastPrivilege`）。
  - `ExecutionTimeLimit` 为 `PT0S`（不限时）；`Priority` 为 5（普通；缺省的 7 低于普通，宿主与看门狗会继承）；`MultipleInstancesPolicy` 为 `IgnoreNew`；用电池时照常启动、不停止；允许按需启动（`schtasks /Run`）。
  - 动作：用执行注册命令的 node（`process.execPath`）运行启动器入口，参数为配置文件的绝对路径，工作目录为仓库根。换了 Node 的安装位置或移动了仓库要重新注册。计划任务会展开动作里的 `%变量%`，路径含 `%`、引号或控制字符时直接报错。
- 注册后与 `status` 都读回任务 XML，核对触发器与运行身份的用户、登录类型、运行级别、命令行、配置文件是否存在、工作目录与上述设置；读回的用户是 SID 时记为未核对。
- **PENDING（真机验证）**：任务文件的编码（现为 UTF-16 LE 带 BOM，与 XML 声明一致）；非提权进程能否为当前用户注册登录触发的任务；`/Query /XML` 输出的编码（依次按 BOM、UTF-16、UTF-8 识别，都不是时报错）与读回的用户形式。
- **运行与停止。** node 是控制台程序，计划任务以交互令牌拉起它时，系统为启动器新开一个控制台窗口（PENDING），日志写在窗口里；在该窗口按 Ctrl+C，按正常顺序停止。关闭窗口不是停止入口：关闭事件同时送达共用该控制台的启动器、宿主与看门狗（Node 中为 `SIGHUP`），三者都不处理，会被直接结束而不经过停止顺序。[来源](https://nodejs.org/api/process.html#signal-events) 用 `schtasks /End` 结束任务同样不经过停止顺序。启动失败时窗口随即关闭、输出随之丢失，排查时在终端里用 `pnpm start` 以同一配置运行。

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

`pnpm secret audit` 不解析文件格式，按字节查找每个条目的值（OBS 与会话这类 JSON 条目只查密码、会话密钥等秘密字段，会话密钥另查解码后的字节、hex 与标准 base64；短于 8 个字符的值不查，只列出），形式包括原文、按三种起始偏移截取的 base64 与 base64url、URL 编码、JSON 转义，以及它们的 UTF-16LE 字节（Windows PowerShell 5.1 缺省重定向写出的就是 UTF-16LE），不给路径时查 `reports/`、`config/`、`.bellis/` 与各配置中状态存储所在的目录。

P2 真机核对（2026-10-27，`spikes/drill-rehearsal.ts`，用维护者的真实配置）：会话进行中与停止后各查一次，都没有命中。核对的条目为 ark、iris、minimax、obs、volcengine、vts，会话进行中另有 session；扫描范围是缺省位置的 356 个文件。B 站的两项凭据（bilibili、bilibili-code）没有录入，随 B 站真实平台的测试暂缓。

## 定时与调度

- libuv 在 Windows 上不调用 `timeBeginPeriod`，Node 定时器的粒度约为系统默认的 15.6ms（S-05 已在 Windows 11 真机上确认）：短于一个时钟周期的 `setTimeout` 也要等满一个周期，略长于整周期的要等两个。不要依赖小于 16ms 的 `setTimeout` 精度，调度一律用单调时钟加截止时间。事件循环延迟的测量值同样包含这一粒度，设异常阈值时要计入。
- 音频播放时钟交给 Stage 的 AudioWorklet 和 OBS，宿主不逐样本定时。
- Win11 起，进程的窗口被完全遮挡或最小化时，系统不再保证高分辨率定时器；后台进程还可能被系统归为 EcoQoS 降低调度优先级。[来源](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod) 对 OBS 浏览器源音频和 sidecar 推理的影响由探针 S-01、S-05 实测。
- S-05 在 Windows 11 台式机上（接电源，平衡计划与平衡电源模式）实测本地 TTS sidecar：缺省没有被节流，时延与显式 HighQoS 相同，直接拉起与按启动器方式隐藏窗口拉起都如此；显式 EcoQoS 时实时率约 +22%、短句首包约 +25%。生成卡在 CPU 侧，EcoQoS 把线程调度到效率核并选低频。[来源](https://learn.microsoft.com/en-us/windows/win32/procthread/quality-of-service)
- 因此推理受 CPU 节流影响明显的 sidecar（目前是本地 TTS）在 Windows 上启动时给自己声明 HighQoS（`ProcessPowerThrottling` 的 ControlMask 含 `EXECUTION_SPEED`、StateMask 不含）。实测显式状态不被之后拉起的子进程继承，所以由真正做推理的解释器自己设置，不由宿主或 venv 的 `python.exe` 代设。健康检查每次读回节流状态（`sidecar.health` 的 `qos`）；本地 TTS 作主音频引擎时，开播预检要求读回为 HighQoS，被改成 EcoQoS（例如任务管理器的“效率模式”）、没有声明或读不到都不通过，非 Windows 不核对。
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
