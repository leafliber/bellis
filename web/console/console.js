"use strict";
const el = id => document.getElementById(id);
const MODES = {live: "直播中", safe_stop: "已暂停", emergency_stop: "紧急停止"};
const PHASES = {
  idle: "空闲", starting: "启动中", transition_wait: "等待画面过渡",
  thinking: "看图思考中", voice_wait: "避让游戏配音", acting: "执行动作并核验",
  decision_wait: "等待人工选择", step_done: "准备下一步",
};
const SCREENS = {
  overworld: "大世界", menu: "菜单", dialogue: "剧情对话", choice: "分支选项",
  combat: "战斗中", loading: "加载中", cutscene: "过场动画",
};
const VOICES = {busy: "配音中", idle: "安静"};
const REASONS = {
  takeover: "真人接管", focus_lost: "游戏失焦", emergency_stop: "紧急停止",
  input_stop: "停止输入", lease_expired: "许可过期", lease_revoked: "手动收回",
  operator_disarm: "手动收回", hook_lost: "底层钩子断开", injection_blocked: "输入被拦截",
  max_steps_exceeded: "步数用尽", vlm_error: "视觉模型异常", proposal_error: "动作解析异常",
  no_visual_change: "画面连续无变化", no_new_frame: "未采集到新画面",
  rejected: "输入被实时核拒绝", cancelled: "已手动取消", goal_timeout: "目标超时",
  safe_stop: "请先点击「开始直播」", busy: "当前已有任务运行，请先点「停止任务」",
  rate_limited: "操作过于频繁，请稍后再试", no_pending_decision: "当前没有待处理的决策点",
};
const VERIFY = {
  verified: "已核验释放", unverified: "核验中", up_failed: "抬键失败",
  residual: "存在残留按住", unavailable: "核验不可用",
};
const STEP_STATUS = {
  verified_changed: ["画面已变化", "ok"], waited: ["等待完成", "off"],
  done: ["已完成", "ok"], resolved: ["已选分支", "ok"],
  no_visual_change: ["画面无变化", "warn"], no_new_frame: ["无新帧", "warn"],
  vlm_error: ["模型超时/错误", "err"], proposal_error: ["动作格式错误", "err"],
  rejected: ["未获授权被拒", "err"], control_released: ["控制已释放", "warn"],
  stop: ["主动停机", "warn"],
};
const PRESETS = {
  "daily-open": {
    mode: "single", steps: 8, arm: true,
    desc: "按 f4 打开星际和平指南，确认停留在每日实训页签并查看活跃度",
  },
  "daily-auto": {
    mode: "continuous", steps: 12, arm: true,
    desc: "打开星际和平指南查看今日每日实训，并逐步推进能安全自动完成的日常任务",
  },
  observe: {
    mode: "single", steps: 3, arm: false,
    desc: "只观察当前游戏画面处于什么界面，严禁点击或按键，直接汇报当前界面与状态",
  },
};

let csrf = "";
let sessionEnded = false;
let renderedDecisionId = "";
let lastStatus = null;
let pollTimer = 0;
const busyButtons = new Set();

const tReason = code => {
  if (!code) return "";
  const head = String(code).split(":", 1)[0];
  return REASONS[code] || REASONS[head] || String(code);
};

function setFeedback(text, tone = "info") {
  const node = el("feedback");
  node.textContent = text;
  node.dataset.tone = tone;
}

function setPill(id, text, state) {
  const node = el(id);
  node.textContent = text;
  node.dataset.state = state;
}

function setDisabled(id, disabled) {
  const node = el(id);
  if (node) node.disabled = sessionEnded || busyButtons.has(id) || disabled;
}

function taskMode() {
  return document.querySelector('input[name="task_mode"]:checked')?.value || "continuous";
}

function syncTaskModeUi() {
  const continuous = taskMode() === "continuous";
  el("steps-label").textContent = continuous ? "最多推进轮数" : "单次最大步数";
  const input = el("task-steps");
  input.max = continuous ? "30" : "20";
  const val = Number(input.value || 0);
  if (continuous && (val < 1 || val > 30)) input.value = "12";
  if (!continuous && (val < 1 || val > 20)) input.value = "8";
}

async function api(path, data, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {};
  const options = {credentials: "same-origin", cache: "no-store", headers, signal: ctrl.signal};
  if (data !== undefined) {
    options.method = "POST";
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-Bellis-Csrf"] = csrf;
    options.body = JSON.stringify(data);
  }
  try {
    const response = await fetch("/api/" + path, options);
    if (response.status === 401) endSession();
    if (!response.ok) {
      let detail = "";
      if (response.status === 409) detail = "（当前状态不允许此操作）";
      if (response.status === 503) detail = "（目标进程尚未连接）";
      throw new Error("请求失败 HTTP " + response.status + detail);
    }
    csrf = response.headers.get("X-Bellis-Csrf") || csrf;
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时（" + Math.round(timeoutMs / 1000) + "s），请检查服务状态");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function endSession() {
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = 0;
  csrf = "";
  sessionEnded = true;
  document.querySelectorAll("button, input, textarea").forEach(node => { node.disabled = true; });
  el("mode").textContent = "会话已失效，请使用终端新链接登录";
  el("lamp").dataset.mode = "";
}

function renderSteps(steps) {
  const list = el("game-steps");
  if (!steps || !steps.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "暂无步骤记录";
    list.replaceChildren(empty);
    return;
  }
  const items = steps.slice().reverse().map(item => {
    const li = document.createElement("li");
    li.className = "step-item";
    const head = document.createElement("div");
    head.className = "step-head";
    const title = document.createElement("strong");
    title.textContent = "#" + item.step + " " + (item.action || "步骤") + (item.summary ? " · " + item.summary : "");
    const badge = document.createElement("span");
    const [label, state] = STEP_STATUS[item.status] || [item.status || "完成", "off"];
    badge.className = "badge";
    badge.dataset.state = state;
    badge.textContent = label;
    head.append(title, badge);
    li.append(head);
    if (item.observation) {
      const obs = document.createElement("span");
      obs.className = "muted";
      obs.textContent = item.observation;
      li.append(obs);
    }
    return li;
  });
  list.replaceChildren(...items);
}

function renderStatus(s) {
  lastStatus = s;
  const live = s.mode === "live";
  const permit = s.game_permit || {};
  const game = s.game_link || {};
  const obj = s.game_objective;
  const queued = s.game_queued_goal;

  el("mode").textContent = MODES[s.mode] || s.mode;
  el("lamp").dataset.mode = s.mode;
  el("reason").textContent = [
    s.emergency_reason && "原因：" + tReason(s.emergency_reason),
    s.watchdog_acted && "看门狗已接管保护",
  ].filter(Boolean).join(" · ");

  setDisabled("logout", false);
  setDisabled("btn-live", s.mode !== "safe_stop");
  setDisabled("btn-pause", s.mode !== "live");
  setDisabled("btn-clear", s.mode !== "emergency_stop");
  setDisabled("btn-emergency", false);

  setPill("pill-stage", "OBS Stage · " + (s.stage_connected ? "已连接" : "未连接"), s.stage_connected ? "ok" : "warn");
  setPill("pill-core", "游戏核 · " + (permit.connected ? "已连接" : "未连接"), permit.connected ? "ok" : "off");
  setPill("pill-agent", "游戏端 · " + (game.connected ? (game.display_name || "已连接") : "未连接"), game.connected ? "ok" : "off");
  const winExtras = [SCREENS[game.screen_kind], VOICES[game.voice_state]].filter(Boolean).join(" · ");
  if (!permit.connected) {
    setPill("pill-window", "游戏窗口 · 未知", "off");
  } else {
    const label = (permit.target_focused ? "游戏窗口 · 前台聚焦" : "游戏窗口 · 未聚焦") + (winExtras ? "（" + winExtras + "）" : "");
    setPill("pill-window", label, permit.target_focused ? "ok" : "warn");
  }

  const pBadge = el("permit-badge");
  const pDetail = el("permit-detail");
  const pBtn = el("btn-permit");
  const idleSec = permit.human_idle_ms != null ? Math.floor(permit.human_idle_ms / 1000) : 0;
  if (!permit.connected) {
    pBadge.textContent = "未连接"; pBadge.dataset.state = "off";
    pDetail.textContent = "请先启动 game-agent / realtime-core";
    pBtn.textContent = "开启代打"; pBtn.className = "primary";
    setDisabled("btn-permit", true);
  } else if (permit.armed) {
    pBadge.textContent = "代打中 #" + permit.active_token; pBadge.dataset.state = "ok";
    pDetail.textContent = permit.target_focused ? "游戏在前台，可安全执行动作" : "游戏未聚焦，即将自动释放";
    pBtn.textContent = "收回控制权"; pBtn.className = "";
    setDisabled("btn-permit", false);
  } else if (permit.arm_pending) {
    const settle = Math.round(permit.arm_settle_s || 2);
    pBadge.textContent = permit.target_focused ? "准备激活" : "等待切窗"; pBadge.dataset.state = "warn";
    pDetail.textContent = permit.target_focused
      ? "已聚焦游戏，请松开键鼠（" + Math.min(idleSec, settle) + "/" + settle + "s）"
      : "请切回游戏窗口并松开键鼠，松手约 " + settle + " 秒后自动开始";
    pBtn.textContent = "取消等待"; pBtn.className = "";
    setDisabled("btn-permit", false);
  } else {
    const waitingResume = permit.auto_resume && (permit.last_release_reason === "takeover" || permit.last_release_reason === "focus_lost");
    const arSec = Math.round(permit.auto_resume_idle_s || 5);
    pBadge.textContent = waitingResume ? "真人已接管" : "未开启";
    pBadge.dataset.state = waitingResume ? "warn" : "off";
    if (waitingResume) {
      pDetail.textContent = permit.target_focused
        ? "松开键鼠 " + Math.min(idleSec, arSec) + "/" + arSec + "s 后自动接回"
        : "切回游戏并空闲 " + arSec + " 秒后自动接回";
    } else if (permit.last_release_reason) {
      const v = VERIFY[permit.last_release_verification] || permit.last_release_verification || "";
      pDetail.textContent = "上次释放：" + tReason(permit.last_release_reason) + (v ? "（" + v + "）" : "");
    } else {
      pDetail.textContent = live ? "点击「开启代打」后切回游戏即可自动生效" : "请先点击顶部「开始直播」";
    }
    pBtn.textContent = "开启代打"; pBtn.className = "primary";
    setDisabled("btn-permit", !live);
  }

  const arToggle = el("auto-resume-toggle");
  const arIdle = el("auto-resume-idle");
  arToggle.checked = Boolean(permit.auto_resume);
  setDisabled("auto-resume-toggle", !permit.connected);
  if (document.activeElement !== arIdle && permit.auto_resume_idle_s) {
    arIdle.value = String(Math.round(permit.auto_resume_idle_s));
  }

  const hasTask = Boolean(game.active_goal_id || queued || obj);
  setDisabled("btn-task-start", !live || !game.connected);
  setDisabled("btn-task-stop", !hasTask);

  const lBadge = el("live-badge");
  const lCount = el("live-step-count");
  const lGoal = el("live-goal");
  if (!game.connected) {
    lBadge.textContent = "未连接"; lBadge.dataset.state = "off";
    lCount.textContent = "";
    lGoal.textContent = "等待 game-agent 接入…";
  } else if (game.active_goal_id) {
    const phase = game.paused ? "已暂缓" : (PHASES[game.phase] || "执行中");
    lBadge.textContent = phase;
    lBadge.dataset.state = game.phase === "decision_wait" || game.phase === "voice_wait" ? "warn" : "ok";
    const stepText = game.max_steps ? "第 " + (game.current_step || 0) + "/" + game.max_steps + " 步" : "";
    const objText = obj ? " · 总进度 " + obj.completed_steps + "/" + obj.max_auto_steps + " 轮" : "";
    lCount.textContent = stepText + objText;
    lGoal.textContent = game.active_goal_description || "执行当前目标";
  } else if (queued) {
    lBadge.textContent = "等待切窗后开跑"; lBadge.dataset.state = "warn";
    lCount.textContent = "最多 " + queued.max_steps + " 步";
    lGoal.textContent = queued.description;
  } else if (obj) {
    lBadge.textContent = obj.auto_continue ? "总目标推进中" : (obj.paused_for_takeover ? "接管暂缓" : "总目标已停");
    lBadge.dataset.state = obj.auto_continue ? "ok" : (obj.paused_for_takeover ? "warn" : "off");
    lCount.textContent = "已完成 " + obj.completed_steps + "/" + obj.max_auto_steps + " 轮";
    lGoal.textContent = obj.description;
  } else {
    lBadge.textContent = "空闲"; lBadge.dataset.state = "off";
    lCount.textContent = "";
    lGoal.textContent = "当前无活动任务";
  }

  const outcomes = {goal_completed: "上次结果：目标已完成", goal_stuck: "上次结果：已停住", control_released: "上次结果：控制已释放"};
  el("live-outcome").textContent = game.last_outcome
    ? [outcomes[game.last_outcome] || game.last_outcome, tReason(game.last_outcome_detail)].filter(Boolean).join(" · ")
    : "";
  el("game-highlight").textContent = game.last_highlight ? "亮点：" + game.last_highlight : "";
  const lines = game.recent_narrative || [];
  el("game-narrative").textContent = lines.length ? "台词：" + lines[lines.length - 1] : "";
  renderSteps(game.recent_steps || []);

  const decision = game.connected && game.pending_decision;
  el("game-decision").hidden = !decision;
  if (!decision) {
    renderedDecisionId = "";
  } else if (decision.decision_id !== renderedDecisionId) {
    renderedDecisionId = decision.decision_id;
    el("decision-question").textContent = decision.question;
    el("decision-options").replaceChildren(...decision.options.map((option, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary";
      btn.textContent = (i + 1) + ". " + option;
      btn.disabled = sessionEnded;
      btn.addEventListener("click", () => runAction(btn, () => api("game/decision", {
        decision_id: decision.decision_id, chosen_index: i,
      }), "已提交分支选择"));
      return btn;
    }));
  }

  setDisabled("btn-say", !live || !s.stage_connected);
  setDisabled("btn-interrupt", !live);
  const heard = s.recent_heard && s.recent_heard.length ? s.recent_heard.slice().reverse() : ["暂无播出记录"];
  el("heard").replaceChildren(...heard.map(line => {
    const li = document.createElement("li");
    li.textContent = line;
    if (line === "暂无播出记录") li.className = "muted";
    return li;
  }));

  const vote = s.active_vote;
  el("vote-status").textContent = vote
    ? vote.question + " · 剩余 " + Math.ceil(vote.remaining_s) + " 秒"
    : "暂无进行中的投票";
  el("counts").replaceChildren(...(vote ? vote.options.map((opt, i) => {
    const li = document.createElement("li");
    li.textContent = opt + " · " + vote.counts[i] + " 票";
    return li;
  }) : []));
  setDisabled("btn-vote-start", !live || Boolean(vote));
  setDisabled("btn-vote-close", !vote);

  el("queue").textContent = "待处理 " + s.pending_danmaku + " 条";
  setDisabled("btn-danmaku", !live);
}

async function refresh() {
  const status = await api("status");
  if (!sessionEnded) renderStatus(status);
}

async function poll() {
  try { await refresh(); }
  catch (error) {
    if (!sessionEnded) setFeedback("状态刷新异常：" + error.message, "warn");
  }
  if (!sessionEnded) pollTimer = window.setTimeout(poll, 1000);
}

async function runAction(button, fn, okText) {
  const id = button?.id || "";
  if (id) busyButtons.add(id);
  if (button) button.disabled = true;
  try {
    const res = await fn();
    if (res && res.ok === false) {
      setFeedback("操作未执行：" + (tReason(res.reason) || "请检查当前状态"), "warn");
    } else if (okText) {
      const msg = typeof okText === "function" ? okText(res) : okText;
      if (msg) setFeedback(msg, "info");
    }
    if (!sessionEnded) await refresh();
    return res;
  } catch (error) {
    setFeedback(error.message, "err");
    return null;
  } finally {
    if (id) busyButtons.delete(id);
    if (lastStatus && !sessionEnded) renderStatus(lastStatus);
    else if (button) button.disabled = sessionEnded;
  }
}

document.querySelectorAll("[data-control]").forEach(btn => {
  btn.addEventListener("click", () => {
    const path = btn.dataset.control;
    const labels = {
      "control/live": "已进入直播状态",
      "control/pause": "已暂停直播并释放活跃控制",
      "control/clear-emergency": "已解除急停（当前为已暂停，可按需重新开始直播）",
      "control/emergency": "已触发紧急停止！",
      "speech/interrupt": "已打断当前发声",
      "vote/close": "已结束当前投票",
    };
    runAction(btn, () => api(path, {}), labels[path] || "操作已完成");
  });
});

el("btn-permit").addEventListener("click", () => {
  const btn = el("btn-permit");
  const p = lastStatus?.game_permit;
  if (p?.armed || p?.arm_pending) {
    runAction(btn, () => api("game/disarm", {}), p.armed ? "已收回游戏控制权" : "已取消等待切窗");
    return;
  }
  runAction(btn, () => api("game/arm", {wait_for_focus: true}), res => (
    res.status === "waiting_focus"
      ? "请切回游戏窗口并松开键鼠，约 2 秒后自动开启代打"
      : "已开启游戏代打"
  ));
});

const syncAutoResume = () => {
  const toggle = el("auto-resume-toggle");
  const idle = Math.min(60, Math.max(2, Number(el("auto-resume-idle").value || 5)));
  runAction(toggle, () => api("game/auto-resume", {enabled: toggle.checked, idle_s: idle}),
    toggle.checked ? "已开启接管后空闲 " + idle + " 秒自动接回" : "已关闭空闲自动接回");
};
el("auto-resume-toggle").addEventListener("change", syncAutoResume);
el("auto-resume-idle").addEventListener("change", () => {
  if (el("auto-resume-toggle").checked) syncAutoResume();
});

document.querySelectorAll('input[name="task_mode"]').forEach(r => r.addEventListener("change", syncTaskModeUi));
document.querySelectorAll("[data-preset]").forEach(chip => {
  chip.addEventListener("click", () => {
    const p = PRESETS[chip.dataset.preset];
    if (!p) return;
    const radio = document.querySelector('input[name="task_mode"][value="' + p.mode + '"]');
    if (radio) radio.checked = true;
    syncTaskModeUi();
    el("task-desc").value = p.desc;
    el("task-steps").value = String(p.steps);
    el("task-auto-arm").checked = p.arm;
    setFeedback("已填入快捷任务「" + chip.textContent + "」，点击「开始执行」即可运行", "info");
  });
});

el("game-task").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const desc = el("task-desc").value.trim();
  const steps = Number(el("task-steps").value || 8);
  const mode = taskMode();
  const wantArm = el("task-auto-arm").checked;
  const btn = el("btn-task-start");
  runAction(btn, async () => {
    let armStatus = lastStatus?.game_permit?.armed ? "armed" : "off";
    if (wantArm && !lastStatus?.game_permit?.armed) {
      const armed = await api("game/arm", {wait_for_focus: true});
      armStatus = armed.status || "armed";
    }
    if (mode === "continuous") {
      const res = await api("game/objective", {
        description: desc, auto_continue: true, max_auto_steps: Math.min(30, Math.max(1, steps)),
      });
      return {...res, _arm: armStatus, _mode: "continuous"};
    }
    if (lastStatus?.game_objective) await api("game/objective", {clear: true});
    const res = await api("game/goal", {
      description: desc, max_steps: Math.min(20, Math.max(1, steps)), wait_for_arm: wantArm,
    });
    return {...res, _arm: armStatus, _mode: "single"};
  }, res => {
    if (res._mode === "continuous") {
      return res._arm === "waiting_focus"
        ? "连续任务已就绪，请切回游戏窗口并松开键鼠（约 2 秒后自动开跑）"
        : res._arm === "armed"
          ? "连续任务已启动，正在拆解第一步…"
          : "连续任务已保存（开启代打后自动推进）";
    }
    return res.queued
      ? "目标已排队，请切回游戏窗口并松开键鼠（约 2 秒后自动执行）"
      : "目标已下发，正在执行…";
  });
});

el("btn-task-stop").addEventListener("click", () => {
  runAction(el("btn-task-stop"), () => api("game/objective", {clear: true, cancel_active: true}), "已停止当前任务并清除连续目标");
});

el("say").addEventListener("submit", event => {
  event.preventDefault();
  const text = event.target.elements.text.value;
  runAction(el("btn-say"), () => api("speech/say", {text}, 60000), res => ({
    completed: "口播已完成", interrupted: "口播已打断", denied: "口播未获授权", failed: "口播失败",
  }[res.status] || "口播请求完成"));
});

el("vote").addEventListener("submit", event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  data.options = data.options.split("\n").map(s => s.trim()).filter(Boolean);
  data.duration_s = Number(data.duration_s);
  runAction(el("btn-vote-start"), () => api("vote/start", data), "已开启观众投票");
});

el("danmaku").addEventListener("submit", event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  runAction(el("btn-danmaku"), () => api("danmaku", data), res => (res.ok ? "测试弹幕已入队" : "测试弹幕被过滤"));
});

el("logout").addEventListener("click", () => {
  runAction(el("logout"), async () => {
    const res = await api("logout", {});
    endSession();
    return res;
  }, "已退出登录");
});

async function connect() {
  syncTaskModeUi();
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  try {
    if (token) csrf = (await api("login", {token})).csrf;
    await refresh();
    pollTimer = window.setTimeout(poll, 1000);
  } catch (error) {
    endSession();
    setFeedback(error.message, "err");
  }
}
connect();
