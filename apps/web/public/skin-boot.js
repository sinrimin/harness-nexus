// Skin pre-paint — sets <html data-skin> before first paint so a saved skin
// never flashes the baseline. Loaded as an external same-origin script from
// index.html (CSP keeps script-src strict — no inline exceptions). Keep the
// id list in sync with apps/web/src/skins/registry.ts.
try {
  var sk = localStorage.getItem('hnx.skin');
  if (sk !== 'bay' && sk !== 'ledger' && sk !== 'nightwatch') sk = 'signal';
  document.documentElement.dataset.skin = sk;
} catch (e) {
  document.documentElement.dataset.skin = 'signal';
}
