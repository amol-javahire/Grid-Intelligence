const BASE = import.meta.env.BASE_URL;

export default function Slide7LiveDemo() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f172a]">
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(#14b8a6 1px, transparent 1px), linear-gradient(90deg, #14b8a6 1px, transparent 1px)",
          backgroundSize: "6vw 6vw",
        }}
      />
      {/* Teal glow bottom-left */}
      <div
        className="absolute bottom-0 left-0 w-[50vw] h-[50vh] opacity-[0.10]"
        style={{ background: "radial-gradient(ellipse at 0% 100%, #14b8a6, transparent 70%)" }}
      />

      <div className="absolute left-0 top-0 bottom-0 w-[0.5vw] bg-[#14b8a6]" />
      <div className="absolute top-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />

      <div className="absolute top-[11vh] left-[8vw]">
        <p className="font-body text-[2.2vw] font-medium tracking-[0.3em] uppercase" style={{ color: "#14b8a6" }}>
          Your Deal Pipeline · Today
        </p>
      </div>

      {/* Split layout */}
      <div className="absolute left-[8vw] right-[3vw] top-[22vh] bottom-[10vh] flex gap-[4vw] items-stretch">

        {/* Left: CTA content */}
        <div className="w-[34vw] flex flex-col justify-between shrink-0">
          <div>
            <h2
              className="font-display font-black tracking-tight leading-[1.0]"
              style={{ fontSize: "5vw", color: "#f1f5f9", textWrap: "balance" }}
            >
              3,875 projects ranked.{" "}
              <span style={{ color: "#14b8a6" }}>Top 50 ready for outreach.</span>
            </h2>
            <div className="mt-[2vh] h-[0.4vh] w-[10vw] bg-[#14b8a6] rounded-full" />
            <p className="font-body font-medium mt-[2.5vh] leading-relaxed" style={{ fontSize: "2.3vw", color: "#94a3b8" }}>
              The platform is live. Ask the Q&A Copilot anything — or open Rankings and filter by ISO, size, and risk score to generate the first outreach list in under 5 minutes.
            </p>
          </div>

          {/* Workflow callouts */}
          <div className="flex flex-col gap-[2vh]">
            <div className="h-[1px] w-full bg-gradient-to-r from-[#14b8a6]/40 to-transparent" />
            <div className="flex flex-col gap-[1.8vh]">
              {[
                {
                  color: "#14b8a6",
                  title: "PPA / Tolling Origination",
                  sub: "Screen → Score → Export CSV → Deal team",
                },
                {
                  color: "#f59e0b",
                  title: "Basis Risk Analysis",
                  sub: "Select PPA node · Map to Walmart store · See 28-month spread",
                },
                {
                  color: "#8b5cf6",
                  title: "Q&A Copilot",
                  sub: '"Which ERCOT wind projects have lowest congestion risk?"',
                },
              ].map((w) => (
                <div key={w.title}>
                  <p className="font-display font-black" style={{ fontSize: "2.6vw", color: w.color }}>{w.title}</p>
                  <p className="font-body" style={{ fontSize: "1.9vw", color: "#94a3b8" }}>{w.sub}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: screenshots */}
        <div className="flex-1 flex flex-col gap-[1.5vh] min-w-0">
          <p
            className="font-body font-medium tracking-widest uppercase shrink-0"
            style={{ fontSize: "1.6vw", color: "#14b8a6" }}
          >
            Live Platform · June 2026
          </p>
          <div className="flex-1 rounded-[0.8vw] overflow-hidden border border-[#14b8a6]/25 shadow-[0_0_48px_rgba(20,184,166,0.14)] min-h-0">
            <img
              src={`${BASE}screenshot-dashboard.jpg`}
              alt="Grid Origination Platform — Dashboard"
              className="w-full h-full object-cover object-top"
            />
          </div>
          <div className="h-[22%] shrink-0 rounded-[0.8vw] overflow-hidden border border-[#f59e0b]/20 shadow-[0_0_32px_rgba(245,158,11,0.10)]">
            <img
              src={`${BASE}screenshot-queue.jpg`}
              alt="Interconnection Queue — 3,493 projects"
              className="w-full h-full object-cover object-top"
            />
          </div>
        </div>
      </div>

      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />
    </div>
  );
}
