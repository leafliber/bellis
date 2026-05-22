import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import AppLayout from "@/components/layout/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Config from "@/pages/Config";
import Observability from "@/pages/Observability";
import { useAppStore } from "@/store/useAppStore";
import { useEventStore } from "@/store/useEventStore";

const DEFAULT_WS_URL = "ws://localhost:8765";

export default function App() {
  const theme = useAppStore((s) => s.theme);
  const connectWS = useEventStore((s) => s.connectWS);
  const wsConnected = useEventStore((s) => s.wsConnected);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [theme]);

  // 启动时自动连接本地后端
  useEffect(() => {
    if (!wsConnected) {
      connectWS(DEFAULT_WS_URL);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Router>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/config" element={<Config />} />
          <Route path="/observability" element={<Observability />} />
        </Route>
      </Routes>
    </Router>
  );
}
