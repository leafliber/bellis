import EventLog from "@/components/dashboard/EventLog";
import StatePanel from "@/components/dashboard/StatePanel";
import ResponseCard from "@/components/dashboard/ResponseCard";
import ControlBar from "@/components/dashboard/ControlBar";

export default function Dashboard() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex gap-4 p-4 overflow-hidden">
        {/* Left panel - Event stream (2/3) */}
        <div className="flex-[2] min-w-0">
          <EventLog />
        </div>

        {/* Right panel - State + Response (1/3) */}
        <div className="flex-1 flex flex-col gap-4 min-w-0 overflow-y-auto">
          <StatePanel />
          <ResponseCard />
        </div>
      </div>

      {/* Bottom control bar */}
      <ControlBar />
    </div>
  );
}
