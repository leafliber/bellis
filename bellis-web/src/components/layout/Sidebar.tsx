import { NavLink } from "react-router-dom";
import { LayoutDashboard, Settings, Activity, Bot, User } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "仪表盘" },
  { to: "/live2d", icon: User, label: "Live2D" },
  { to: "/config", icon: Settings, label: "配置" },
  { to: "/observability", icon: Activity, label: "可观测性" },
];

export default function Sidebar() {
  const { theme, toggleTheme, wsConnected, isAgentRunning } = useAppStore();

  return (
    <aside className="flex flex-col h-full w-56 border-r border-[var(--border)] bg-[var(--surface)]">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-[var(--border)]">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--primary)]/20">
          <Bot className="w-5 h-5 text-[var(--primary)]" />
        </div>
        <div>
          <h1 className="text-base font-bold text-[var(--text)] tracking-tight">Bellis</h1>
          <p className="text-[10px] text-[var(--text-muted)] leading-none">Live AI Agent</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-[var(--primary)]/15 text-[var(--primary)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--overlay)]/50"
              )
            }
          >
            <Icon className="w-4.5 h-4.5" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="px-3 py-4 border-t border-[var(--border)] space-y-3">
        {/* Connection status */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--overlay)]/30">
          <div
            className={cn(
              "w-2 h-2 rounded-full",
              wsConnected ? "bg-[var(--success)] animate-pulse" : "bg-[var(--error)]"
            )}
          />
          <span className="text-xs text-[var(--text-muted)]">
            {wsConnected ? "已连接" : "未连接"}
          </span>
        </div>

        {/* Agent status */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--overlay)]/30">
          <div
            className={cn(
              "w-2 h-2 rounded-full",
              isAgentRunning ? "bg-[var(--success)] animate-pulse" : "bg-[var(--text-muted)]"
            )}
          />
          <span className="text-xs text-[var(--text-muted)]">
            {isAgentRunning ? "运行中" : "已停止"}
          </span>
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--overlay)]/50 transition-all w-full"
        >
          {theme === "dark" ? "☀️ 亮色模式" : "🌙 暗色模式"}
        </button>
      </div>
    </aside>
  );
}
