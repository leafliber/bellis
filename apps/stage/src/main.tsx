import { StrictMode } from "react";
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
  createRoot(root).render(
    <StrictMode>
      <StagePage profile={resolveProfile()} />
    </StrictMode>,
  );
}
