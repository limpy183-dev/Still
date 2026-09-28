// Shared by the main window and alarm screens: accessibility preferences become body classes plus page zoom.
// Text size is page zoom, so the width breakpoints in styles.css reflow the layout as they do in a browser.
function applyAccessibility(prefs, setZoom) {
  const value = prefs || {};
  for (const [name, key] of [['reduced-motion', 'reducedMotion'], ['high-contrast', 'highContrast'], ['readable-font', 'readableFont'], ['strong-focus', 'strongFocus']]) document.body.classList.toggle(name, value[key] === true);
  if (setZoom) setZoom((Number(value.textSize) || 100) / 100);
}
