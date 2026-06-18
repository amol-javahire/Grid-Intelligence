const BASE = import.meta.env.BASE_URL;

export default function Slide4Scoring() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f172a]">
      {/* Left teal accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-[0.5vw] bg-[#14b8a6]" />

      {/* Top rule */}
      <div className="absolute top-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />

      {/* Label */}
      <div className="absolute top-[11vh] left-[8vw]">
        <p
          className="font-body text-[2.2vw] font-medium tracking-[0.3em] uppercase"
          style={{ color: "#14b8a6" }}
        >
          Scoring Engine
        </p>
      </div>

      {/* Left column: headline + dimensions */}
      <div className="absolute left-[8vw] top-[20vh] bottom-[10vh] w-[38vw] flex flex-col justify-between">
        <div>
          <h2
            className="font-display font-black tracking-tight leading-[1.0]"
            style={{ fontSize: "4.6vw", color: "#f1f5f9", textWrap: "balance" }}
          >
            Eight dimensions. Every project. Fully ranked.
          </h2>
          <p
            className="font-body font-medium mt-[2.5vh] leading-relaxed"
            style={{ fontSize: "2.4vw", color: "#94a3b8" }}
          >
            Each EIA 860 generator is scored from real nodal and queue data — no manual analysis.
          </p>
        </div>

        {/* Dimension pills */}
        <div className="grid grid-cols-2 gap-[0.8vw] mt-[2vh]">
          {[
            { label: "Congestion Risk", color: "#14b8a6" },
            { label: "Curtailment Risk", color: "#14b8a6" },
            { label: "Basis Risk", color: "#f59e0b" },
            { label: "Tax Credit Eligibility", color: "#f59e0b" },
            { label: "Sponsor Quality", color: "#8b5cf6" },
            { label: "Interconnect Risk", color: "#8b5cf6" },
            { label: "Capture Price", color: "#94a3b8" },
            { label: "Market Revenue", color: "#94a3b8" },
          ].map(({ label, color }) => (
            <div
              key={label}
              className="bg-[#1e293b] rounded-[0.5vw] px-[1.2vw] py-[1vh] flex items-center gap-[1vw]"
            >
              <div
                className="w-[0.5vw] h-[3vh] rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <p
                className="font-display font-bold leading-tight"
                style={{ fontSize: "2vw", color: "#f1f5f9" }}
              >
                {label}
              </p>
            </div>
          ))}
        </div>

        {/* Hero stat */}
        <div className="mt-[2vh]">
          <div className="h-[1px] w-full bg-gradient-to-r from-[#14b8a6]/50 to-transparent mb-[1.5vh]" />
          <div className="flex items-baseline gap-[1vw]">
            <p
              className="font-display font-black tracking-tighter leading-none"
              style={{ fontSize: "7vw", color: "#14b8a6" }}
            >
              3,875
            </p>
            <p
              className="font-body font-medium"
              style={{ fontSize: "2.2vw", color: "#94a3b8" }}
            >
              projects ranked across 3 ISO markets
            </p>
          </div>
        </div>
      </div>

      {/* Vertical divider */}
      <div className="absolute left-[50vw] top-[20vh] bottom-[10vh] w-[1px] bg-gradient-to-b from-transparent via-[#14b8a6]/30 to-transparent" />

      {/* Right column: live screenshot */}
      <div className="absolute right-[3vw] top-[20vh] bottom-[10vh] w-[44vw] flex flex-col">
        <p
          className="font-body font-medium mb-[1.2vh] tracking-widest uppercase"
          style={{ fontSize: "1.6vw", color: "#14b8a6" }}
        >
          Live — ERCOT Congestion Analysis
        </p>
        <div className="flex-1 rounded-[0.8vw] overflow-hidden border border-[#14b8a6]/20 shadow-[0_0_40px_rgba(20,184,166,0.12)]">
          <img
            src={`${BASE}screenshot-congestion.jpg`}
            alt="ERCOT Congestion Analysis — DA-RT spread ranking"
            className="w-full h-full object-cover object-top"
          />
        </div>
      </div>

      {/* Bottom rule */}
      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />
    </div>
  );
}
