export default function Slide6TechStack() {
  const opportunities = [
    {
      icon: "⚡",
      color: "#14b8a6",
      title: "On-site Solar + Storage",
      subtitle: "Supercenter rooftop + canopy",
      stats: ["1–3 MW solar per store", "Demand charge reduction", "IRA ITC 30–40% credit"],
      body: "Walmart has committed to on-site renewables at distribution centers and large supercenters. Platform identifies which stores sit in favorable ERCOT/CAISO nodes for solar capture price.",
    },
    {
      icon: "🔋",
      color: "#f59e0b",
      title: "Battery Storage Hedge",
      subtitle: "Peak shaving + ancillary revenue",
      stats: ["1–5 MW / 4-hr per location", "ERCOT ORDC ancillary upside", "Demand charge: $15–30/MWh"],
      body: "Battery storage co-located with EV charging hubs can shift peak demand, earn ERCOT ancillary (ORDC) revenue, and provide backup during ERCOT scarcity events — all while hedging retail rate exposure.",
    },
    {
      icon: "🚗",
      color: "#8b5cf6",
      title: "EV Charging Load Strategy",
      subtitle: "Walmart's fast-charger rollout",
      stats: ["350–1,000 kW per hub", "Smart charging = grid asset", "Potential DR revenue"],
      body: "Walmart's multi-thousand EV stall buildout creates a new load profile. Platform models how managed EV charging participates in demand response and how storage offsets coincident peak charges.",
    },
  ];

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f172a]">
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: "radial-gradient(circle, #14b8a6 1px, transparent 1px)",
          backgroundSize: "4vw 4vw",
        }}
      />
      <div className="absolute left-0 top-0 bottom-0 w-[0.5vw] bg-[#14b8a6]" />
      <div className="absolute top-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />

      <div className="absolute top-[11vh] left-[8vw] right-[8vw] flex items-baseline justify-between">
        <p className="font-body text-[2.2vw] font-medium tracking-[0.3em] uppercase" style={{ color: "#14b8a6" }}>
          EV Charging + Battery Storage
        </p>
        <p className="font-body text-[2vw]" style={{ color: "#94a3b8" }}>
          New load = new opportunity to hedge
        </p>
      </div>

      <div className="absolute top-[20vh] left-[8vw] right-[8vw]">
        <h2
          className="font-display font-black tracking-tight leading-tight"
          style={{ fontSize: "4.2vw", color: "#f1f5f9", textWrap: "balance" }}
        >
          Walmart's EV rollout adds{" "}
          <span style={{ color: "#f59e0b" }}>500–1,000 MW</span>{" "}
          of new peak load. Storage + smart charging turn that into a{" "}
          <span style={{ color: "#14b8a6" }}>grid asset.</span>
        </h2>
      </div>

      {/* Three columns */}
      <div className="absolute left-[8vw] right-[8vw]" style={{ top: "40vh", bottom: "10vh" }}>
        <div className="grid grid-cols-3 gap-[2.5vw] h-full">
          {opportunities.map((o) => (
            <div
              key={o.title}
              className="bg-[#1e293b] rounded-[1vw] p-[2.5vw] flex flex-col"
              style={{ borderTop: `0.4vh solid ${o.color}` }}
            >
              <div className="flex items-center gap-[1.2vw] mb-[1.5vh]">
                <span style={{ fontSize: "3.5vw" }}>{o.icon}</span>
                <div>
                  <p className="font-display font-black leading-tight" style={{ fontSize: "2.6vw", color: "#f1f5f9" }}>{o.title}</p>
                  <p className="font-body" style={{ fontSize: "1.9vw", color: o.color }}>{o.subtitle}</p>
                </div>
              </div>

              <p className="font-body leading-relaxed flex-1" style={{ fontSize: "2.1vw", color: "#94a3b8" }}>{o.body}</p>

              <div className="mt-[2vh] flex flex-col gap-[0.6vh]">
                {o.stats.map((s) => (
                  <div key={s} className="flex items-center gap-[0.8vw]">
                    <div className="w-[0.5vw] h-[0.5vw] rounded-full shrink-0" style={{ background: o.color }} />
                    <span className="font-body font-medium" style={{ fontSize: "1.9vw", color: o.color }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />
    </div>
  );
}
