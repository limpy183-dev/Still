const { allowedTarget } = require('./domain.cjs');
const SOUNDS = ['chime', 'bloom', 'bell', 'pulse', 'silent', 'custom'];
const MEDIA_FILE = /^[a-f0-9-]{36}\.(mp3|wav|ogg|m4a|aac|flac|mp4|mov|webm|png|jpe?g|gif|webp)$/i;
function localDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Choose a valid date.');
  const [y, m, d] = value.split('-').map(Number), date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw Error('Choose a valid date.');
  return date;
}
function atTime(date, time) { const result = new Date(date); const [h, m] = time.split(':').map(Number); result.setHours(h, m, 0, 0); return +result; }
function validateAlert(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid alert.');
  const title = String(value.title || '').trim();
  if (!title || title.length > 120) throw Error('Give your alert a task, up to 120 characters.');
  localDate(value.date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw Error('Choose a valid start time.');
  if (!['once', 'daily', 'weekdays'].includes(value.repeat)) throw Error('Choose a repeat schedule.');
  if (!['duration', 'range'].includes(value.lengthMode)) throw Error('Choose a duration or time range.');
  if (!Number.isInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 1440) throw Error('Choose 1–1,440 whole minutes.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.endTime)) throw Error('Choose a valid end time.');
  if (value.lengthMode === 'range' && value.endTime === value.time) throw Error('Start and end times must be different.');
  if (!['full', 'card', 'notification'].includes(value.style)) throw Error('Choose an alarm style.');
  const snoozeLimit = value.snoozeLimit ?? null;
  if (snoozeLimit !== null && (!Number.isInteger(snoozeLimit) || snoozeLimit < 0 || snoozeLimit > 100)) throw Error('Choose 0–100 snoozes, or unlimited.');
  if (value.showDismiss !== undefined && typeof value.showDismiss !== 'boolean') throw Error('Choose whether to show Dismiss.');
  if (!['none', 'current', 'custom'].includes(value.blockMode)) throw Error('Choose which apps or websites to block.');
  if (!Array.isArray(value.apps) || value.apps.length > 100 || !value.apps.every(allowedTarget)) throw Error('Choose up to 100 apps or websites.');
  if (value.blockMode === 'custom' && !value.apps.length) throw Error('Select apps or websites to block, or choose “No blocking”.');
  if (!Number.isInteger(value.unlockDelayMinutes) || value.unlockDelayMinutes < 0 || value.unlockDelayMinutes > 120) throw Error('Choose a release delay from 0 to 120 minutes.');
  if (!SOUNDS.includes(value.sound) || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 100) throw Error('Choose a sound and volume.');
  const asset = item => {
    if (!item) return null;
    if (!MEDIA_FILE.test(item.file) || typeof item.name !== 'string') throw Error('Choose a media file using the file picker.');
    return { file: item.file, name: item.name.slice(0, 200) };
  };
  const soundFile = asset(value.soundFile), banner = asset(value.banner);
  if (value.sound === 'custom' && !soundFile) throw Error('Choose your custom sound file.');
  if (value.style === 'full' && (value.sound === 'silent' || value.volume === 0)) throw Error('Full-screen alarms need an audible sound.');
  return { title, note: String(value.note || '').slice(0, 500), date: value.date, time: value.time, repeat: value.repeat,
    lengthMode: value.lengthMode, durationMinutes: value.durationMinutes, endTime: value.endTime, style: value.style, snoozeLimit, showDismiss: value.showDismiss !== false,
    blockMode: value.blockMode, apps: value.apps.map(({ name, path }) => ({ name: name.slice(0, 100), path })),
    unlockDelayMinutes: value.unlockDelayMinutes, sound: value.sound, volume: value.volume, soundFile, banner, enabled: value.enabled !== false };
}
function occurrenceOn(alert, day) {
  const startDay = localDate(alert.date);
  const midnight = new Date(day); midnight.setHours(0, 0, 0, 0);
  if (+midnight < +startDay || (alert.repeat === 'once' && +midnight !== +startDay) || (alert.repeat === 'weekdays' && [0, 6].includes(midnight.getDay()))) return null;
  const start = atTime(midnight, alert.time);
  let end = start + alert.durationMinutes * 60000;
  if (alert.lengthMode === 'range') {
    const endDay = new Date(midnight);
    if (alert.endTime < alert.time) endDay.setDate(endDay.getDate() + 1);
    end = atTime(endDay, alert.endTime);
  }
  return { start, end };
}
function dueOccurrence(alert, now) {
  if (!alert.enabled) return null;
  if (alert.repeat === 'once') {
    const occurrence = occurrenceOn(alert, localDate(alert.date));
    return occurrence.start <= now && occurrence.start > (alert.lastOccurrence || 0) ? occurrence : null;
  }
  // A wake/relaunch catches up today's slot (or yesterday's overnight slot), never a backlog.
  for (let offset = 0; offset >= -1; offset--) {
    const day = new Date(now); day.setDate(day.getDate() + offset);
    const occurrence = occurrenceOn(alert, day);
    if (occurrence && occurrence.start <= now && occurrence.start > (alert.lastOccurrence || 0)) return occurrence;
  }
  return null;
}
function nextOccurrence(alert, now) {
  if (!alert.enabled) return null;
  const due = dueOccurrence(alert, now);
  if (due && due.end > now) return due.start;
  const firstDay = new Date(Math.max(now, +localDate(alert.date)));
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(firstDay); day.setDate(day.getDate() + offset);
    const occurrence = occurrenceOn(alert, day);
    if (occurrence && occurrence.start > now && occurrence.start > (alert.lastOccurrence || 0)) return occurrence.start;
  }
  // One-time alerts may be months away.
  if (alert.repeat === 'once') { const occurrence = occurrenceOn(alert, localDate(alert.date)); if (occurrence.start > now) return occurrence.start; }
  return null;
}
module.exports = { validateAlert, dueOccurrence, nextOccurrence, occurrenceOn, MEDIA_FILE };
