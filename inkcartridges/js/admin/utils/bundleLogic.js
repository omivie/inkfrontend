/**
 * Bundle (pack) health logic — mirrors the server's packHealthService.js
 * recommendation matrix so the FE can render Recommended Action chips
 * without round-trips and the dual labels stay in sync.
 *
 * recommendAction precedence:
 *   1. Broken because a constituent SKU is *missing* from products  → deactivate
 *   2. Broken because a constituent SKU is present but *inactive*   → regenerate
 *   3. Healthy structure but actual retail drifted from expected    → reprice
 *   4. Otherwise                                                    → none
 *
 * driftSeverity maps absolute dollar drift to a colour bucket so the
 * BundleTreeSheet drift banner stays inside the colour-blind-safe palette
 * (green tick / amber triangle / red cross).
 */

const RECOMMENDED_ACTIONS = ['none', 'reprice', 'deactivate', 'regenerate'];

function recommendAction(p) {
  const isBroken = !!p?.isBroken;
  const missing = Array.isArray(p?.missing) ? p.missing : [];
  const inactive = Array.isArray(p?.inactive) ? p.inactive : [];
  const drifted = !!p?.drifted;
  if (isBroken && missing.length > 0 && inactive.length === 0) return 'deactivate';
  if (isBroken && inactive.length > 0) return 'regenerate';
  if (drifted) return 'reprice';
  return 'none';
}

function driftSeverity(delta) {
  const abs = Math.abs(Number(delta) || 0);
  if (abs <= 0.01) return 'green';
  if (abs <= 0.50) return 'yellow';
  return 'red';
}

function actionLabel(action) {
  switch (action) {
    case 'reprice': return 'Reprice to match singles';
    case 'deactivate': return 'Deactivate (missing constituent)';
    case 'regenerate': return 'Regenerate (constituent inactive)';
    case 'none': return 'Healthy';
    default: return action ? String(action) : 'Unknown';
  }
}

function actionTone(action) {
  switch (action) {
    case 'reprice': return 'warning';
    case 'deactivate': return 'critical';
    case 'regenerate': return 'critical';
    case 'none': return 'healthy';
    default: return 'unknown';
  }
}

const COLOR_DOT_CLASS = {
  Cyan: 'cc-color-dot--cyan',
  Magenta: 'cc-color-dot--magenta',
  Yellow: 'cc-color-dot--yellow',
  Black: 'cc-color-dot--black',
};

const BundleLogic = {
  RECOMMENDED_ACTIONS,
  recommendAction,
  driftSeverity,
  actionLabel,
  actionTone,
  COLOR_DOT_CLASS,
};

export {
  RECOMMENDED_ACTIONS,
  recommendAction,
  driftSeverity,
  actionLabel,
  actionTone,
  COLOR_DOT_CLASS,
  BundleLogic,
};
export default BundleLogic;
