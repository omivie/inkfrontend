/**
 * Charts — Lazy-loaded Chart.js wrapper with theme awareness
 */

let _chartJsLoaded = false;
let _chartJsPromise = null;

async function ensureChartJs() {
  if (_chartJsLoaded || window.Chart) {
    _chartJsLoaded = true;
    return;
  }
  if (_chartJsPromise) return _chartJsPromise;

  _chartJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js';
    script.onload = () => { _chartJsLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load Chart.js'));
    document.head.appendChild(script);
  });
  return _chartJsPromise;
}

function getThemeColors() {
  const style = getComputedStyle(document.body);
  return {
    text: style.getPropertyValue('--text').trim() || '#e2e2ea',
    textMuted: style.getPropertyValue('--text-muted').trim() || '#555568',
    border: style.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.06)',
    cyan: style.getPropertyValue('--cyan').trim() || '#267FB5',
    magenta: style.getPropertyValue('--magenta').trim() || '#C71F6E',
    yellow: style.getPropertyValue('--yellow').trim() || '#F4C430',
    success: style.getPropertyValue('--success').trim() || '#34D399',
    danger: style.getPropertyValue('--danger').trim() || '#ef4444',
    surface: style.getPropertyValue('--surface').trim() || '#12121e',
  };
}

function baseOptions(colors) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: colors.surface,
        titleColor: colors.text,
        bodyColor: colors.text,
        borderColor: colors.border,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 6,
        titleFont: { family: "'Plus Jakarta Sans', sans-serif", weight: '600' },
        bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
      },
    },
    scales: {
      x: {
        ticks: { color: colors.textMuted, font: { size: 11 }, maxRotation: 0 },
        grid: { color: colors.border, drawBorder: false },
        border: { display: false },
      },
      y: {
        ticks: { color: colors.textMuted, font: { size: 11 } },
        grid: { color: colors.border, drawBorder: false },
        border: { display: false },
      },
    },
  };
}

const Charts = {
  _instances: new Map(),

  async line(canvasId, { labels, datasets, options = {} }) {
    await ensureChartJs();
    this.destroy(canvasId);

    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const colors = getThemeColors();
    const opts = baseOptions(colors);
    Object.assign(opts, options);
    if (options.scales) {
      Object.assign(opts.scales.x, options.scales.x || {});
      Object.assign(opts.scales.y, options.scales.y || {});
    }

    const chart = new window.Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: opts,
    });

    this._instances.set(canvasId, chart);
    return chart;
  },

  async bar(canvasId, { labels, datasets, options = {} }) {
    await ensureChartJs();
    this.destroy(canvasId);

    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const colors = getThemeColors();
    const opts = baseOptions(colors);
    Object.assign(opts, options);

    const chart = new window.Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: opts,
    });

    this._instances.set(canvasId, chart);
    return chart;
  },

  async doughnut(canvasId, { labels, data, colors: chartColors, options = {} }) {
    await ensureChartJs();
    this.destroy(canvasId);

    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const themeColors = getThemeColors();

    const chart = new window.Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: chartColors || [themeColors.cyan, themeColors.magenta, themeColors.yellow, themeColors.success, themeColors.danger],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: themeColors.surface,
            titleColor: themeColors.text,
            bodyColor: themeColors.text,
            borderColor: themeColors.border,
            borderWidth: 1,
            padding: 10,
            cornerRadius: 6,
          },
        },
        ...options,
      },
    });

    this._instances.set(canvasId, chart);
    return chart;
  },

  destroy(canvasId) {
    const existing = this._instances.get(canvasId);
    if (existing) {
      existing.destroy();
      this._instances.delete(canvasId);
    }
  },

  destroyAll() {
    for (const [id, chart] of this._instances) {
      chart.destroy();
    }
    this._instances.clear();
  },

  getThemeColors,
};

export { Charts };
