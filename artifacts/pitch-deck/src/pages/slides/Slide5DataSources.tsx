export default function Slide5DataSources() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f172a]">
      <div className="absolute left-0 top-0 bottom-0 w-[0.5vw] bg-[#14b8a6]" />
      <div className="absolute top-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />

      <div className="absolute top-[11vh] left-[8vw]">
        <p className="font-body text-[2.2vw] font-medium tracking-[0.3em] uppercase" style={{ color: "#14b8a6" }}>
          Hedging Supercenter Load · Basis Risk
        </p>
      </div>

      {/* Headline */}
      <div className="absolute top-[20vh] left-[8vw] right-[8vw]">
        <h2
          className="font-display font-black tracking-tight leading-tight"
          style={{ fontSize: "4.5vw", color: "#f1f5f9", textWrap: "balance" }}
        >
          The hidden cost: your PPA delivers power at{" "}
          <span style={{ color: "#f59e0b" }}>Node A.</span>{" "}
          Walmart pays bills at{" "}
          <span style={{ color: "#f59e0b" }}>Node B.</span>
        </h2>
        <p className="font-body font-medium mt-[1.5vh]" style={{ fontSize: "2.4vw", color: "#94a3b8" }}>
          Basis risk = the spread between your generation settlement point and Walmart's retail load zone. Over a 20-year PPA, this can cost or save tens of millions.
        </p>
      </div>

      {/* Three risk panels */}
      <div className="absolute left-[8vw] right-[8vw]" style={{ top: "46vh", bottom: "10vh" }}>
        <div className="grid grid-cols-3 gap-[2.5vw] h-full">

          {/* Congestion basis */}
          <div className="bg-[#1e293b] rounded-[1vw] p-[2.5vw] flex flex-col border-t-[0.4vh] border-[#14b8a6]">
            <p className="font-body font-medium tracking-widest uppercase mb-[1vh]" style={{ fontSize: "2vw", color: "#14b8a6" }}>
              ERCOT Congestion
            </p>
            <p className="font-display font-black leading-tight" style={{ fontSize: "3.5vw", color: "#f1f5f9" }}>
              $37/MWh spread
            </p>
            <p className="font-body mt-[1.5vh] flex-1" style={{ fontSize: "2.1vw", color: "#94a3b8" }}>
              West Texas wind PPA vs. LZ_HOUSTON load zone — 28 months of real CDR data. CREZ line congestion spikes in high-wind hours.
            </p>
            <div className="mt-auto pt-[1.5vh] border-t border-[#14b8a6]/20">
              <p className="font-body" style={{ fontSize: "2vw", color: "#14b8a6" }}>317,475 hourly rows · Jan 2024–May 2026</p>
            </div>
          </div>

          {/* CAISO basis */}
          <div className="bg-[#1e293b] rounded-[1vw] p-[2.5vw] flex flex-col border-t-[0.4vh] border-[#f59e0b]">
            <p className="font-body font-medium tracking-widest uppercase mb-[1vh]" style={{ fontSize: "2vw", color: "#f59e0b" }}>
              CAISO Curtailment
            </p>
            <p className="font-display font-black leading-tight" style={{ fontSize: "3.5vw", color: "#f1f5f9" }}>
              12–18% negative price
            </p>
            <p className="font-body mt-[1.5vh] flex-1" style={{ fontSize: "2.1vw", color: "#94a3b8" }}>
              SP15 solar captures ~75% of DA price at midday due to duck curve curtailment. NP15 wind fares better at 88%+.
            </p>
            <div className="mt-auto pt-[1.5vh] border-t border-[#f59e0b]/20">
              <p className="font-body" style={{ fontSize: "2vw", color: "#f59e0b" }}>OASIS PRC_LMP · NP15, SP15, ZP26</p>
            </div>
          </div>

          {/* Walmart node map */}
          <div className="bg-[#1e293b] rounded-[1vw] p-[2.5vw] flex flex-col border-t-[0.4vh] border-[#8b5cf6]">
            <p className="font-body font-medium tracking-widest uppercase mb-[1vh]" style={{ fontSize: "2vw", color: "#8b5cf6" }}>
              Store → Node Mapping
            </p>
            <p className="font-display font-black leading-tight" style={{ fontSize: "3.5vw", color: "#f1f5f9" }}>
              Haversine match
            </p>
            <p className="font-body mt-[1.5vh] flex-1" style={{ fontSize: "2.1vw", color: "#94a3b8" }}>
              Each Walmart location geolocated to nearest settlement point. Platform auto-scores basis risk per store vs. candidate PPA project node.
            </p>
            <div className="mt-auto pt-[1.5vh] border-t border-[#8b5cf6]/20">
              <p className="font-body" style={{ fontSize: "2vw", color: "#8b5cf6" }}>1,123 ERCOT nodes · 1,774 CAISO nodes</p>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />
    </div>
  );
}
