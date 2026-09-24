// Built-in sounds are generated locally: no downloads, codecs, or extra dependencies.
function playAlertSound(alert, { repeat = false, onError = () => {} } = {}) {
  let context, audio, interval, stopped = false;
  const stop = () => { stopped = true; clearInterval(interval); if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); } if (context && context.state !== 'closed') context.close(); };
  if (alert.sound === 'silent' || alert.volume === 0) return stop;
  if (alert.sound === 'custom' && alert.soundFile) {
    audio = new Audio(`still-media://local/${alert.soundFile.file}`); audio.volume = alert.volume / 100; audio.loop = repeat;
    let failed = false;
    const fail = () => { if (failed || stopped) return; failed = true; stop(); onError('This sound could not play. Try MP3 or WAV.'); };
    audio.addEventListener('error', fail, { once: true }); audio.play().catch(fail);
    return stop;
  }
  context = new AudioContext();
  const melodies = { chime: [659.25, 830.61, 987.77], bloom: [261.63, 329.63, 392, 523.25], bell: [880, 660, 880], pulse: [440, 440, 554.37, 554.37] };
  const play = () => {
    if (stopped) return;
    (melodies[alert.sound] || melodies.chime).forEach((frequency, i) => {
      const oscillator = context.createOscillator(), gain = context.createGain(), at = context.currentTime + i * .27;
      oscillator.type = alert.sound === 'pulse' ? 'triangle' : 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(alert.volume / 100 * .22, at + .02); gain.gain.exponentialRampToValueAtTime(.001, at + .9);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(at); oscillator.stop(at + 1);
    });
  };
  context.resume().then(play).catch(() => onError('Audio could not start. Check your sound output.'));
  if (repeat) interval = setInterval(play, 3000);
  else setTimeout(stop, 2500);
  return stop;
}
