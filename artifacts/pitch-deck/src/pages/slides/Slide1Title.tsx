export default function Slide1Title() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f172a]">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(#14b8a6 1px, transparent 1px), linear-gradient(90deg, #14b8a6 1px, transparent 1px)",
          backgroundSize: "6vw 6vw",
        }}
      />

      {/* Left teal accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-[0.5vw] bg-[#14b8a6]" />

      {/* Top rule */}
      <div className="absolute top-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />

      {/* Walmart badge */}
      <div className="absolute top-[11vh] right-[7vw] flex items-center gap-[1.2vw]">
        <div className="w-[1px] h-[5vh] bg-[#14b8a6]/40" />
        <div>
          <p className="font-body text-[1.8vw] font-semibold tracking-widest uppercase" style={{ color: "#14b8a6" }}>
            Prepared for
          </p>
          <p className="font-display font-black text-[2.8vw]" style={{ color: "#f59e0b" }}>
            Walmart Energy Procurement
          </p>
        </div>
      </div>

      {/* Main content */}
      <div className="absolute inset-0 flex flex-col justify-center pl-[8vw] pr-[12vw]">
        {/* Overline */}
        <p className="font-body text-[2.2vw] font-medium tracking-[0.3em] uppercase mb-[3vh]" style={{ color: "#14b8a6" }}>
          Power Market Intelligence
        </p>

        {/* Headline */}
        <h1
          className="font-display font-black leading-[0.95] tracking-tighter mb-[4vh]"
          style={{ fontSize: "8.5vw", color: "#f1f5f9", textWrap: "balance" }}
        >
          Grid Origination
          <span style={{ color: "#14b8a6" }}> Intelligence</span>
        </h1>

        {/* Subtitle */}
        <p className="font-body font-medium leading-relaxed max-w-[54vw]" style={{ fontSize: "2.8vw", color: "#94a3b8" }}>
          PPA origination · Tolling agreements · Supercenter load hedging · EV + storage siting
        </p>

        {/* Value prop strip */}
        <div className="flex items-center gap-[3vw] mt-[6vh]">
          <div className="h-[1px] w-[6vw] bg-[#14b8a6]" />
          <div className="flex items-center gap-[1vw]">
            <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-[#14b8a6]" />
            <span className="font-body text-[2.2vw] font-semibold" style={{ color: "#f1f5f9" }}>3,875 projects ranked</span>
          </div>
          <div className="w-[1px] h-[3vh] bg-[#94a3b8]/30" />
          <div className="flex items-center gap-[1vw]">
            <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-[#f59e0b]" />
            <span className="font-body text-[2.2vw] font-semibold" style={{ color: "#f1f5f9" }}>ERCOT · CAISO · PJM</span>
          </div>
          <div className="w-[1px] h-[3vh] bg-[#94a3b8]/30" />
          <div className="flex items-center gap-[1vw]">
            <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-[#8b5cf6]" />
            <span className="font-body text-[2.2vw] font-semibold" style={{ color: "#f1f5f9" }}>Real ISO nodal data</span>
          </div>
        </div>
      </div>

      {/* Right geometric accent */}
      <div className="absolute right-[6vw] bottom-[25vh] flex flex-col items-end gap-[1.5vh]">
        <div className="w-[20vw] h-[1px] bg-gradient-to-l from-[#14b8a6]/60 to-transparent" />
        <div className="w-[14vw] h-[1px] bg-gradient-to-l from-[#f59e0b]/40 to-transparent" />
        <div className="w-[9vw] h-[1px] bg-gradient-to-l from-[#8b5cf6]/40 to-transparent" />
      </div>

      {/* Bottom rule */}
      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />
    </div>
  );
}
