let stopSound = () => {};
const get = id => document.getElementById(id);
window.alarm.onData(item => {
  const alert = item.alert;
  get('alarm-snooze').hidden = item.preview || (alert.snoozeLimit != null && (alert.snoozeCount || 0) >= alert.snoozeLimit);
  get('alarm-dismiss').hidden = get('alarm-dismiss-top').hidden = !item.preview && alert.showDismiss === false;
  document.body.classList.add('alarm-' + alert.style);
  document.body.classList.toggle('reduced-motion', !!item.reducedMotion);
  get('alarm-title').textContent = alert.title; get('alarm-note').textContent = alert.note;
  get('alarm-message').textContent = item.message;
  get('alarm-time').textContent = item.occurrence.end <= Date.now() ? 'This focus window has ended' : 'Until ' + new Date(item.occurrence.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!item.preview && item.occurrence.end <= Date.now() + 5 * 60000) get('alarm-footnote').textContent = 'The focus window ends before the 5-minute snooze returns. That reminder will not restart or extend app blocking.';
  if (item.preview) { get('alarm-eyebrow').textContent = 'YOUR ALARM · PREVIEW'; get('alarm-snooze').hidden = true; }
  if (alert.banner && alert.style !== 'notification') {
    const video = /\.(mp4|mov|webm)$/i.test(alert.banner.file), media = document.createElement(video ? 'video' : 'img');
    if (video) { media.muted = true; media.loop = true; media.autoplay = !item.reducedMotion; media.controls = true; media.playsInline = true; }
    else media.alt = 'Your alert banner';
    media.src = 'still-media://local/' + alert.banner.file;
    media.onerror = () => { get('alarm-media').hidden = true; get('alarm-error').textContent = 'Banner could not play. Try a JPG, GIF, or H.264 MP4.'; };
    get('alarm-media').replaceChildren(media); get('alarm-media').hidden = false;
  }
  if (item.audible) {
    stopSound = playAlertSound(alert, { repeat: alert.style !== 'notification', onError: message => {
      get('alarm-error').textContent = message + ' Playing the default chime instead.';
      stopSound = playAlertSound({ ...alert, sound: 'chime' }, { repeat: alert.style !== 'notification' });
    } });
    setTimeout(() => stopSound(), alert.style === 'notification' ? 6000 : 60000);
  }
});
window.alarm.onMessage(message => { get('alarm-message').textContent = message; });
async function action(name) {
  try { await window.alarm.action(name); stopSound(); }
  catch (error) { get('alarm-error').textContent = error.message; }
}
get('alarm-dismiss').onclick = get('alarm-dismiss-top').onclick = () => action('dismiss');
get('alarm-open').onclick = () => action('open'); get('alarm-snooze').onclick = () => action('snooze');
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !get('alarm-dismiss').hidden) action('dismiss'); });
window.addEventListener('beforeunload', () => stopSound());
