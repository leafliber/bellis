一、工具生态调研
弹幕源
库	Stars	说明
bilibili-api (Nemo2011)	4k	Python异步，直播WS弹幕+礼物+SC全覆盖，最全
blivedm (xfgryujk)	~1k	专注B站直播弹幕WS，更轻量
bilibili_danmaku (MerlynAllen)	~200	最轻量
TTS
库	Stars	说明
GPT-SoVITS	40k+	零/少样本语音克隆，HTTP API，中文最强
ChatTTS	~30k	自然对话式TTS
Fish Speech	~15k	多语言TTS
Edge-TTS	~5k	微软免费TTS，零部署，质量一般
VoiceVox	~3k	日语免费TTS，HTTP API
ASR
库	说明
Faster-Whisper	CTranslate2加速版Whisper，本地运行，中英文都行
FunASR (阿里)	中文优化ASR
Azure Speech	云端，低延迟
Live2D / 虚拟形象
方案	说明
pixi-live2d-display-lipsyncpatch	前端渲染+口型同步，WebSocket接收表情/动作指令，Open-LLM-VTuber在用
live2d-py (EasyLive2D)	Python C扩展，可本地渲染模型+口型，但不适合直接推流
Stretchy Studio 前端	AI绑定+动画，开发中live2d导出，WebSocket可驱动
关键结论：Live2D渲染必须在前端（浏览器/ Electron），Python后端通过 WebSocket 推送 {expression, motion, mouth} 指令给前端。这是 Open-LLM-VTuber 验证过的成熟方案。

推流/平台控制
库	说明
obsws-python	OBS WebSocket Python客户端，控制场景切换/源显隐/录制
FFmpeg subprocess	直接推RTMP到B站直播服务器
bilibili-api	B站开播/关播/获取推流地址/发弹幕
已有Python框架
框架	Stars	架构	致命短板
Open-LLM-VTuber	7.7k	串行管道，消息队列粘合	无agent循环、无hook、无插件系统
airi	39.4k	TypeScript，模块化	不是Python
结论：没有现成的 LangGraph + PydanticAI + 插件化的 Python 方案。这是空白地带。

二、架构路线
分层总览
┌─────────────────────────────────────────────────────────────────────┐
│                        LangGraph StateGraph                          │
│                                                                       │
│   ┌──────────┐      ┌──────────┐      ┌──────────┐                 │
│   │ PERCEIVE │─────→│  THINK   │─────→│   ACT    │                 │
│   │  感知层  │      │  思考层   │      │  行动层  │                 │
│   └──────────┘      └──────────┘      └──────────┘                 │
│        ↑  ↖              │                  │                       │
│   hooks  idle           hooks             hooks                    │
│        ↑  ↖              ↓                  ↓                       │
│   ┌─────────────────────────────────────────────────┐              │
│   │              Shared State (TypedDict)             │              │
│   └─────────────────────────────────────────────────┘              │
│                                                                       │
│   每个节点 = 一个 PydanticAI Agent（独立定义/测试/替换模型）         │
└─────────────────────────────────────────────────────────────────────┘

         ↕ Plugin 边界                   ↕ Plugin 边界
┌─────────────────────┐         ┌─────────────────────┐
│   Input Plugins      │         │   Output Plugins     │
│  ┌─────────────────┐│         │┌─────────────────┐  │
│  │ B站弹幕         ││         ││ GPT-SoVITS TTS  │  │
│  │ (bilibili-api)  ││         │├─────────────────┤  │
│  ├─────────────────┤│         ││ Live2D WS       │  │
│  │ 语音ASR         ││         ││ (pixi-l2d)      │  │
│  │ (Faster-Whisper)││         │├─────────────────┤  │
│  ├─────────────────┤│         ││ B站弹幕回复      │  │
│  │ 礼物/SC事件     ││         │├─────────────────┤  │
│  ├─────────────────┤│         ││ OBS 场景切换     │  │
│  │ 抖音弹幕(未来)  ││         │├─────────────────┤  │
│  └─────────────────┘│         ││ 终端输出(调试)   │  │
└─────────────────────┘         │└─────────────────┘  │
                                └─────────────────────┘
┌─────────────────────┐         ┌─────────────────────┐
│  Platform Plugins    │         │   Tool Plugins       │
│  B站开播/关播/认证   │         │  搜歌/查天气/翻译   │
│  抖音(未来)          │         │  记忆检索/代码执行   │
└─────────────────────┘         └─────────────────────┘
                                ┌─────────────────────┐
                                │   Hook Plugins       │
                                │  口癖/敏感词/情绪增强 │
                                │  日志审计/行为统计    │
                                └─────────────────────┘
五类 Plugin 接口
类型	接口方法	职责	已知可对接的库
InputPlugin	listen() → AsyncIterator[Event]	产生输入事件流	bilibili-api, blivedm, Faster-Whisper
OutputPlugin	emit(action: Action)	消费输出动作	GPT-SoVITS API, VoiceVox API, Edge-TTS, WebSocket→Live2D前端, obsws-python, bilibili-api发弹幕
PlatformPlugin	start_stream() / stop_stream() / get_room_info()	平台控制	bilibili-api (开播/推流地址), FFmpeg (推流)
ToolPlugin	get_tools() → list[ToolDef]	为Think Agent提供工具	任意Python函数包装
HookPlugin	register_hooks(hook_mgr)	注册hook到主循环	—
Hook 系统（6个挂载点）
pre_perceive → [PERCEIVE] → post_perceive
pre_think    → [THINK]    → post_think
pre_act      → [ACT]      → post_act
Hook函数签名：async (state) -> state，可修改state、打日志、触发外部通知。

LangGraph 图结构
PERCEIVE ──(should_respond?)──→ THINK ──→ ACT ──→ PERCEIVE  (主循环)
    │                              ↑
    └────(idle)────→ IDLE ────────┘         (空闲自言自语)
条件路由：感知层判断是否需要回复
空闲自言自语：idle_ticks超阈值后伪装一个"需要回复"信号
循环：act完回到perceive，不是终点
Event / Action 标准化模型
Event（输入插件→感知层）：

type: danmaku / gift / super_chat / voice / enter / follow / system
通用字段: user_id, username, content, timestamp
礼物字段: gift_name, gift_count, coin_amount
语音字段: audio_data, language
Action（行动层→输出插件）：

type: speak / set_expression / set_motion / reply_danmaku / change_bg / tool_call / custom
说话字段: text, emotion
Live2D字段: expression, motion
弹幕字段: reply_text
Live2D通信协议
后端 → 前端（WebSocket JSON）：

{"type": "speak", "text": "你好呀", "emotion": "happy"}
{"type": "expression", "name": "happy"}
{"type": "motion", "name": "wave"}
前端（pixi-live2d-display-lipsyncpatch）接收后：播放口型同步+TTS音频+表情/动作。

三、开发路线
Phase 0：骨架搭建
项目结构 + pyproject.toml
State 定义（TypedDict）
五类 Plugin ABC + PluginRegistry
HookManager
LangGraph 图骨架（perceive/think/act/idle 节点 + 条件路由）
PydanticAI Agent 定义（三层的 result_type + deps_type）
Console 输入/输出插件（调试用，唯一内置实现）
入口 app.py：加载插件 → 编译图 → 跑主循环
目标：终端里能对话，证明整个循环跑通
Phase 1：B站直播能力
B站弹幕 InputPlugin（bilibili-api 或 blivedm）
B站弹幕回复 OutputPlugin
B站 PlatformPlugin（开播/关播/推流地址）
Edge-TTS OutputPlugin（零部署，先跑起来）
Console Live2D 模拟输出（打印表情/动作指令，不接真实前端）
Phase 2：虚拟形象 + 语音
Live2D OutputPlugin（WebSocket → 前端）
前端页面（pixi-live2d-display + WebSocket客户端）
GPT-SoVITS / Fish Speech OutputPlugin（高质量语音克隆）
Faster-Whisper InputPlugin（语音弹幕）
Phase 3：智能增强
ToolPlugin 机制接入 Think Agent（搜歌、查天气、记忆检索）
HookPlugin 生态（口癖、敏感词、情绪增强、行为统计）
长期记忆（Redis / SQLite + 向量检索）
多人设切换
Phase 4：多平台 + 生产化
抖音/YouTube InputPlugin
OBS OutputPlugin（场景自动切换）
配置热重载
Web 管理面板
Docker 一键部署
四、关键设计决策
决策	选项	选择	理由
Agent框架	纯LangChain / LangGraph / CrewAI	LangGraph	有状态图+循环+条件路由，最适合主循环编排
Agent定义	原生LangChain / PydanticAI	PydanticAI	类型安全输出+依赖注入+结构化result，比裸prompt强
插件加载	入口文件硬编码 / 动态发现	入口文件显式注册	虚拟主播场景插件不多，显式比魔法更可靠
Live2D方案	Python本地渲染 / 前端渲染	前端渲染	Live2D SDK是JS的，Python渲染无法推流；WS协议已验证
弹幕库	bilibili-api / blivedm	bilibili-api	更全面（弹幕+礼物+SC+开播），社区活跃
TTS起步	GPT-SoVITS / Edge-TTS	先Edge-TTS后GPT-SoVITS	Edge零部署能快速验证，GPT-SoVITS质量高但需GPU