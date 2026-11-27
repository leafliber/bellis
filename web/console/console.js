"use strict";
const el = id => document.getElementById(id);
const modes = {live: "直播中", safe_stop: "已暂停", emergency_stop: "紧急停止"};
let csrf = "";
let sessionEnded = false;
let renderedDecisionId = "";

function setAuthenticated(value) {
  document.querySelectorAll("button").forEach(button => { button.disabled = !value; });
}

async function api(path, data) {
  const headers = {};
  const options = {credentials: "same-origin", cache: "no-store", headers};
  if (data !== undefined) {
    options.method = "POST";
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-Bellis-Csrf"] = csrf;
    options.body = JSON.stringify(data);
  }
  const response = await fetch("/api/" + path, options);
  if (response.status === 401) endSession();
  if (!response.ok) throw new Error("请求失败（HTTP " + response.status + "）");
  csrf = response.headers.get("X-Bellis-Csrf") || csrf;
  return response.json();
}

function endSession() {
  csrf = "";
  sessionEnded = true;
  setAuthenticated(false);
  el("mode").textContent = "请使用新的一次性链接登录";
  el("lamp").dataset.mode = "";
}

function list(id, lines) {
  el(id).replaceChildren(...lines.map(line => {
    const item = document.createElement("li");
    item.textContent = line;
    return item;
  }));
}

async function refresh() {
  const s = await api("status");
  if (sessionEnded) return;
  el("mode").textContent = modes[s.mode] || s.mode;
  el("lamp").dataset.mode = s.mode;
  el("reason").textContent = [s.emergency_reason, s.watchdog_acted && "看门狗已触发"].filter(Boolean).join(" · ");
  el("stage").textContent = "Stage " + (s.stage_connected ? "已连接" : "未连接");
  const permit = s.game_permit;
  let state = "未连接";
  if (permit?.connected) state = permit.armed ? "已授权 #" + permit.active_token : "已连接·未授权";
  if (permit?.last_release_reason) {
    state += " · " + permit.last_release_reason + " / " + permit.last_release_verification;
  }
  el("game-permit").textContent = "游戏核 " + state;
  const game = s.game_link;
  const outcomes = {goal_completed: "目标已完成", goal_stuck: "目标已停止", control_released: "控制已释放"};
  const voice = game?.voice_state && game.voice_state !== "unknown" ? "配音 " + game.voice_state : "";
  const screen = game?.screen_kind && game.screen_kind !== "unknown" ? "画面 " + game.screen_kind : "";
  el("game-status").textContent = game?.connected ? [
    game.display_name, game.paused ? "已暂缓" : game.active_goal_id ? "执行中" : "空闲",
    voice, screen, game.active_goal_description, outcomes[game.last_outcome], game.last_outcome_detail
  ].filter(Boolean).join(" · ") : "游戏端 未连接";
  const obj = s.game_objective;
  el("game-objective-status").textContent = obj ? [
    "总目标 · " + obj.description,
    obj.auto_continue ? "自动推进中" : "自动推进已停",
    obj.completed_steps + "/" + obj.max_auto_steps
  ].join(" · ") : "";
  el("game-highlight").textContent = game?.last_highlight ? "最近亮点 · " + game.last_highlight : "";
  const lines = game?.recent_narrative || [];
  el("game-narrative").textContent = lines.length ? "最近台词 · " + lines[lines.length - 1] : "";
  const decision = game?.connected && game.pending_decision;
  el("game-decision").hidden = !decision;
  if (!decision) {
    renderedDecisionId = "";
  } else if (decision.decision_id !== renderedDecisionId) {
    renderedDecisionId = decision.decision_id;
    el("decision-question").textContent = decision.question;
    el("decision-options").replaceChildren(...decision.options.map((option, i) => {
      const button = document.createElement("button");
      button.textContent = option;
      button.disabled = sessionEnded;
      button.addEventListener("click", () => command("game/decision", {
        decision_id: decision.decision_id, chosen_index: i
      }, button));
      return button;
    }));
  }
  el("queue").textContent = "待处理弹幕 " + s.pending_danmaku;
  list("heard", s.recent_heard.length ? s.recent_heard.slice().reverse() : ["暂无播出记录"]);
  const vote = s.active_vote;
  el("vote-status").textContent = vote ? vote.question + " · 剩余 " + Math.ceil(vote.remaining_s) + " 秒" : "暂无进行中的投票";
  list("counts", vote ? vote.options.map((option, i) => option + " · " + vote.counts[i] + " 票") : []);
}

async function poll() {
  try { await refresh(); }
  catch (error) {
    if (!sessionEnded) el("mode").textContent = "状态更新失败";
  }
  if (!sessionEnded) window.setTimeout(poll, 1000);
}

async function command(path, data, button) {
  button.disabled = true;
  try {
    const result = await api(path, data);
    const outcomes = {completed: "播报完成", interrupted: "播报已打断", denied: "播报未获授权", failed: "播报失败"};
    const denied = path === "danmaku" ? "弹幕已过滤" : "操作未执行" + (result.reason ? " · " + result.reason : "");
    el("feedback").textContent = outcomes[result.status] || (result.ok === false ? denied : "操作已完成");
    if (path === "logout") endSession();
    else await refresh();
  } catch (error) {
    el("feedback").textContent = error.message;
  } finally {
    button.disabled = sessionEnded;
  }
}

document.querySelectorAll("[data-control]").forEach(button => {
  button.addEventListener("click", () => command(button.dataset.control, {}, button));
});
el("logout").addEventListener("click", () => command("logout", {}, el("logout")));
for (const [id, path] of [
  ["say", "speech/say"], ["danmaku", "danmaku"], ["vote", "vote/start"],
  ["game-goal", "game/goal"], ["game-objective", "game/objective"]
]) {
  el(id).addEventListener("submit", event => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    if (id === "game-goal") data.max_steps = Number(data.max_steps);
    if (id === "game-objective") {
      data.auto_continue = Boolean(form.querySelector("[name=auto_continue]")?.checked);
      data.max_auto_steps = Number(data.max_auto_steps);
    }
    if (id === "vote") {
      data.options = data.options.split("\n").map(s => s.trim()).filter(Boolean);
      data.duration_s = Number(data.duration_s);
    }
    command(path, data, event.submitter || form.querySelector("button"));
  });
}

async function connect() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  try {
    if (token) csrf = (await api("login", {token})).csrf;
    await refresh();
    setAuthenticated(true);
    window.setTimeout(poll, 1000);
  } catch (error) {
    endSession();
    el("feedback").textContent = error.message;
  }
}
connect();
