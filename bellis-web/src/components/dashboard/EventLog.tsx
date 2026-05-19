import { useEffect, useRef } from "react";
import { useEventStore } from "@/store/useEventStore";
import EventItem from "./EventItem";
import { Radio } from "lucide-react";

export default function EventLog() {
  const events = useEventStore((s) => s.events);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <div className="flex flex-col h-full rounded-xl bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
        <Radio className="w-4 h-4 text-[var(--primary)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">事件流</h2>
        <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)]">
          {events.length} 条
        </span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
            等待事件...
          </div>
        ) : (
          events.map((event, i) => <EventItem key={`${event.timestamp}-${i}`} event={event} />)
        )}
      </div>
    </div>
  );
}
