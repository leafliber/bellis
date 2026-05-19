import type { GUITraceSpan } from "@/types";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

interface TracePanelProps {
  traces: GUITraceSpan[];
}

function TraceNode({ span, depth = 0 }: { span: GUITraceSpan; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = span.children && span.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 px-2 hover:bg-[var(--overlay)]/20 rounded cursor-pointer transition-colors"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          <ChevronRight
            className={`w-3 h-3 text-[var(--text-muted)] transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3" />
        )}
        <span className="text-xs font-medium text-[var(--text)]">{span.name}</span>
        <span className="ml-auto text-[10px] font-mono text-[var(--warning)]">{span.duration_ms.toFixed(1)}ms</span>
      </div>
      {expanded && hasChildren && (
        <div>
          {span.children.map((child, i) => (
            <TraceNode key={i} span={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TracePanel({ traces }: TracePanelProps) {
  if (traces.length === 0) {
    return <div className="text-sm text-[var(--text-muted)] py-4 text-center">暂无追踪数据</div>;
  }

  return (
    <div className="space-y-1">
      {traces.map((trace, i) => (
        <TraceNode key={i} span={trace} />
      ))}
    </div>
  );
}
