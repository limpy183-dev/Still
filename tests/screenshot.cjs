// Page capture only: the Rust app needs no window resizing to render a full page.
module.exports = async function screenshot(application, window, file) { await window.screenshot({ path: file }); };
