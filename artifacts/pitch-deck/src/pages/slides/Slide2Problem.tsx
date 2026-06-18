export default function Slide2Problem() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0f172a]">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0f172a] via-[#0f172a] to-[#1a0a2e]" />
      <div className="absolute left-0 top-0 bottom-0 w-[0.5vw] bg-[#14b8a6]" />
      <div className="absolute top-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />

      <div className="absolute top-[11vh] left-[8vw]">
        <p className="font-body text-[2.2vw] font-medium tracking-[0.3em] uppercase" style={{ color: "#14b8a6" }}>
          Walmart's Energy Scale
        </p>
      </div>

      {/* Single flex-col container — no absolute overlap */}
      <div className="absolute left-[8vw] right-[8vw]" style={{ top: "20vh", bottom: "10vh" }}>
        <div className="h-full flex flex-col" style={{ gap: "2.5vh" }}>

          {/* Stats strip — fixed height so it never bleeds into next section */}
          <div className="flex gap-[2vw]" style={{ height: "13vh", flexShrink: 0 }}>
            {[
              { value: "$2B+", label: "annual US electricity cost", color: "#f59e0b" },
              { value: "4,700+", label: "stores + distribution centers", color: "#14b8a6" },
              { value: "2035", label: "100% renewable energy goal", color: "#8b5cf6" },
            ].map((s) => (
              <div
                key={s.value}
                className="flex-1 bg-[#1e293b] rounded-[0.8vw] px-[2vw] flex items-center gap-[1.2vw] border border-white/5"
              >
                <p className="font-display font-black leading-none shrink-0" style={{ fontSize: "3.6vw", color: s.color }}>
                  {s.value}
                </p>
                <p className="font-body" style={{ fontSize: "1.8vw", color: "#94a3b8", lineHeight: 1.3 }}>
                  {s.label}
                </p>
              </div>
            ))}
          </div>

          {/* Two-column section — takes remaining space */}
          <div className="flex-1 flex gap-[4vw] min-h-0">

            {/* Left: headline + body */}
            <div className="flex-1 flex flex-col justify-center min-w-0">
              <h2
                className="font-display font-black tracking-tight"
                style={{ fontSize: "4vw", color: "#f1f5f9", lineHeight: 1.05, textWrap: "balance" }}
              >
                Procurement complexity is{" "}
                <span style={{ color: "#f59e0b" }}>outpacing the tools.</span>
              </h2>
              <p
                className="font-body font-medium leading-relaxed"
                style={{ fontSize: "2.1vw", color: "#94a3b8", marginTop: "2.5vh" }}
              >
                Walmart's load spans three ISOs with different nodal pricing regimes, queue dynamics,
                and congestion patterns — managed today by spreadsheets and broker calls.
              </p>
            </div>

            {/* Divider */}
            <div className="w-[1px] self-stretch bg-gradient-to-b from-transparent via-[#14b8a6]/40 to-transparent" />

            {/* Right: three pain-point cards */}
            <div className="flex flex-col justify-center min-h-0" style={{ width: "42vw", gap: "1.8vh" }}>
              {[
                {
                  icon: "⚡",
                  title: "Volatile basis exposure",
                  body: "Each 1¢/MWh of unhedged basis across Walmart's portfolio = ~$20M/yr of unbudgeted cost.",
                },
                {
                  icon: "🔌",
                  title: "EV load arriving fast",
                  body: "Thousands of EV stalls = 500–1,000 MW of new peak demand. Storage strategy needed now.",
                },
                {
                  icon: "📋",
                  title: "Queue risk unquantified",
                  body: "New ERCOT/CAISO PPAs need queue-depth analysis — most brokers skip this step entirely.",
                },
              ].map((p) => (
                <div
                  key={p.title}
                  className="bg-[#1e293b] rounded-[0.8vw] flex items-start gap-[1.5vw]"
                  style={{ padding: "1.5vh 2vw" }}
                >
                  <span className="shrink-0" style={{ fontSize: "2.4vw", marginTop: "0.2vh" }}>{p.icon}</span>
                  <div>
                    <p className="font-display font-bold" style={{ fontSize: "2.3vw", color: "#f1f5f9" }}>{p.title}</p>
                    <p className="font-body" style={{ fontSize: "1.85vw", color: "#94a3b8", marginTop: "0.3vh", lineHeight: 1.4 }}>
                      {p.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] h-[1px] bg-gradient-to-r from-[#14b8a6] via-[#14b8a6]/40 to-transparent" />
    </div>
  );
}
