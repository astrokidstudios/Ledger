// Chart.js wrappers that read colours from the page's CSS tokens,
// so light and dark mode both get their own validated steps.
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const live = new WeakMap();

function common(fmtY) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { color: css('--ink-2'), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
      tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtY(c.parsed.y)}` } },
    },
    scales: {
      x: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--muted') } },
      y: { grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), callback: (v) => fmtY(v, true) } },
    },
  };
}

function mount(canvas, cfg) {
  live.get(canvas)?.destroy();
  const ch = new window.Chart(canvas, cfg);
  live.set(canvas, ch);
  return ch;
}

export function barChart(canvas, labels, series, fmtY) {
  return mount(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.name, data: s.values, backgroundColor: css(`--s${i + 1}`),
        borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start', maxBarThickness: 22,
        borderColor: css('--surface'), borderWidth: { left: 1, right: 1 },
      })),
    },
    options: common(fmtY),
  });
}

export function lineChart(canvas, labels, series, fmtY) {
  const o = common(fmtY);
  return mount(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.name, data: s.values, borderColor: css(`--s${i + 1}`), backgroundColor: css(`--s${i + 1}`),
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.25, borderDash: s.dashed ? [5, 4] : undefined,
      })),
    },
    options: o,
  });
}
