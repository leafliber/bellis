import { createRoot } from "react-dom/client";
import { StagePage } from "./StagePage.js";

/**
 * Stage 入口：/stage/:profile 路由（P2 最小路由：路径段直接解析，
 * 不引入路由库）。P3 的 Lane Adapter 在此处向 StageApp 注册。
 */
function resolveProfile(): string {
  const match = /^\/stage\/([^/]+)$/.exec(location.pathname);
  const profile = match?.[1];
  if (profile === undefined || profile.length === 0) {
    document.body.innerHTML =
      "<main><h1>Bellis Stage</h1><p>缺少 profile：请访问 /stage/&lt;profile&gt;</p></main>";
    return "default";
  }
  return decodeURIComponent(profile);
}

const root = document.getElementById("stage-root");
if (root !== null) {
  // 不使用 StrictMode：一次性 startup token 的认证引导无法承受开发态
  // 双挂载（第二次 mount 复用已消费 token 必然 401）；连接生命周期由
  // StageApp 单元测试与 pagehide 清理覆盖。
  createRoot(root).render(<StagePage profile={resolveProfile()} />);
}
