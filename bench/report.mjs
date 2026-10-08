// Shared timing + reporting for competitor harnesses.

export function makeTimer() {
  const phases = [];
  let suiteStart = 0;
  return {
    start() {
      suiteStart = performance.now();
    },
    async phase(name, rows, fn) {
      const t0 = performance.now();
      const affected = await fn();
      const secs = (performance.now() - t0) / 1000;
      const n = affected ?? rows;
      phases.push({ name, rows: n, secs });
      console.log(
        `  ${name.padEnd(22)} ${String(n).padStart(8)} rows  ${secs
          .toFixed(2)
          .padStart(8)}s  ${Math.round(n / secs)
          .toLocaleString()
          .padStart(12)} rec/s`,
      );
      return affected;
    },
    report(label) {
      const total = (performance.now() - suiteStart) / 1000;
      const rows = phases.reduce((s, p) => s + p.rows, 0);
      console.log("  " + "-".repeat(64));
      console.log(
        `  ${("TOTAL — " + label).padEnd(22)} ${String(rows).padStart(
          8,
        )} rows  ${total.toFixed(2).padStart(8)}s  ${Math.round(rows / total)
          .toLocaleString()
          .padStart(12)} rec/s`,
      );
      return { label, total, rows, phases };
    },
  };
}
