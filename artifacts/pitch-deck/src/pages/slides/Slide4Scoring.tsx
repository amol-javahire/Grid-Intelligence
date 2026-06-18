const BASE = import.meta.env.BASE_URL;

export default function Slide4Scoring() {
  const dimensions = [
    { label: "Congestion Risk", weight: "22%", color: "#14b8a6", detail: "DA–RT spread at the generation node vs. Walmart load zone" },
    { label: "Curtailment Risk", weight: "30%", color: "#14b8a6", detail: "Negative price frequency + queue depth in the same region" },
    { label: "Basis Risk", weight: "18%", color: "#f59e0b", detail: "Generation node LMP vs. Walmart supercenter settlement point" },
    { label: "Interconnect Risk", weight: "12%", color: "#f59e0b", detail: "Queue position, vintage, ISO study milestone" },
    { label: "Capture Price", weight: "8%", color: "#8b5cf6", detail: "Hourly DA price weighted by generation profile" },
    { label: "Market Revenue", weight: "3%", color: "#8b5cf6", detail: "Ancillary service + capacity market upside" },
    { label: "Sponsor Quality", weight: "4%", color: "#94a3b8", detail: "Developer track record, balance sheet, prior CODs" },
    { label: "Tax Credit Eligibility", weight: "3%", color: "#94a3b8", detail: "IRA PTC/ITC status, adder eligibility, transferability" },
  ];

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f172a]">
      <div className="absolute left-0 top-0 bottom-0 w-[0.5vw] bg-[#14b8a6]" />
      <div className="absolute top-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />

      <div className="absolute top-[11vh] left-[8vw]">
        <p className="font-body text-[2.2vw] font-medium tracking-[0.3em] uppercase" style={{ color: "#14b8a6" }}>
          PPA Origination — Scoring Engine
        </p>
      </div>

      {/* Left: dimensions */}
      <div className="absolute left-[8vw] top-[20vh] bottom-[10vh] w-[40vw] flex flex-col">
        <h2
          className="font-display font-black tracking-tight leading-[1.05]"
          style={{ fontSize: "4.2vw", color: "#f1f5f9", textWrap: "balance" }}
        >
          Eight dimensions, weighted for{" "}
          <span style={{ color: "#14b8a6" }}>Walmart's risk profile.</span>
        </h2>
        <p className="font-body font-medium mt-[1.5vh]" style={{ fontSize: "2.2vw", color: "#94a3b8" }}>
          Every EIA 860 generator scored from real nodal + queue data. No manual analysis. No broker estimates.
        </p>

        <div className="flex flex-col gap-[0.9vh] mt-[2.5vh] flex-1">
          {dimensions.map(({ label, weight, color, detail }) => (
            <div key={label} className="bg-[#1e293b] rounded-[0.5vw] px-[1.5vw] py-[0.9vh] flex items-center gap-[1.5vw]">
              <div className="w-[0.5vw] h-[3.5vh] rounded-full shrink-0" style={{ backgroundColor: color }} />
              <div className="flex-1 min-w-0">
                <p className="font-display font-bold" style={{ fontSize: "2vw", color: "#f1f5f9" }}>{label}</p>
                <p className="font-body truncate" style={{ fontSize: "1.7vw", color: "#94a3b8" }}>{detail}</p>
              </div>
              <p className="font-display font-black shrink-0" style={{ fontSize: "2.2vw", color }}>{weight}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="absolute left-[51vw] top-[20vh] bottom-[10vh] w-[1px] bg-gradient-to-b from-transparent via-[#14b8a6]/30 to-transparent" />

      {/* Right: screenshot */}
      <div className="absolute right-[3vw] top-[20vh] bottom-[10vh] w-[43vw] flex flex-col">
        <p className="font-body font-medium mb-[1.2vh] tracking-widest uppercase shrink-0" style={{ fontSize: "1.6vw", color: "#14b8a6" }}>
          Live — Ranked Candidate Pipeline
        </p>
        <div className="flex-1 rounded-[0.8vw] overflow-hidden border border-[#14b8a6]/20 shadow-[0_0_40px_rgba(20,184,166,0.12)]">
          <img
            src={`${BASE}screenshot-congestion.jpg`}
            alt="ERCOT Congestion Analysis — project scoring"
            className="w-full h-full object-cover object-top"
          />
        </div>
        {/* Stat */}
        <div className="flex items-baseline gap-[1vw] mt-[2vh]">
          <p className="font-display font-black tracking-tighter" style={{ fontSize: "5.5vw", color: "#14b8a6" }}>3,875</p>
          <p className="font-body font-medium" style={{ fontSize: "2vw", color: "#94a3b8" }}>projects ranked · top 50 export-ready for deal team</p>
        </div>
      </div>

      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />
    </div>
  );
}
