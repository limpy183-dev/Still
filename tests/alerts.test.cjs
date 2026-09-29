const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAlert, dueOccurrence, nextOccurrence, occurrenceOn, wakeTaskXml } = require('../app/alert-domain.cjs');
const { validatePreferences } = require('../app/domain.cjs');
const base = { title: 'Write a chapter', note: '', date: '2026-09-23', time: '09:00', repeat: 'once', lengthMode: 'duration', durationMinutes: 50, endTime: '10:00', style: 'card', blockMode: 'none', apps: [], unlockDelayMinutes: 5, sound: 'chime', volume: 65, enabled: true };
const at = value => +new Date(value);
test('alert boundary rejects unsafe apps, invalid schedules and silent full-screen alarms', () => {
  assert.equal(validateAlert(base).title, base.title);
  assert.equal(validateAlert(base).snoozeLimit, null);
  assert.equal(validateAlert(base).showDismiss, true);
  assert.equal(validateAlert(base).onTop, true);
  assert.equal(validateAlert({ ...base, onTop: false }).onTop, false);
  assert.throws(() => validateAlert({ ...base, onTop: 'no' }));
  for (const snoozeLimit of [-1, 1.5, 101, '2']) assert.throws(() => validateAlert({ ...base, snoozeLimit }));
  assert.throws(() => validateAlert({ ...base, showDismiss: 'false' }));
  for (const change of [{ title: '' }, { time: '25:00' }, { date: '2026-02-30' }, { durationMinutes: 0 }, { durationMinutes: 1.5 }, { repeat: 'hourly' }, { blockMode: 'custom' }, { apps: [{ name: 'Windows', path: 'C:\\Windows\\explorer.exe' }] }, { sound: 'custom' }, { style: 'full', volume: 0 }, { style: 'full', sound: 'silent' }, { banner: { file: '../../private.png', name: 'bad' } }, { lengthMode: 'range', endTime: '09:00' }]) assert.throws(() => validateAlert({ ...base, ...change }));
});
test('one-time, missed and consumed occurrences survive clock changes without duplicates', () => {
  const alert = validateAlert(base), now = at('2026-09-23T09:01:00');
  assert.equal(dueOccurrence(alert, now).start, at('2026-09-23T09:00:00'));
  assert.equal(dueOccurrence({ ...alert, lastOccurrence: at('2026-09-23T09:00:00') }, now), null);
  assert.equal(dueOccurrence(alert, at('2026-09-23T08:59:00')), null);
  assert.equal(nextOccurrence({ ...alert, enabled: false }, now), null);
  assert.equal(nextOccurrence(alert, at('2026-09-23T10:00:00')), null);
  assert.ok(dueOccurrence(alert, at('2026-09-24T10:00:00')).end < at('2026-09-24T10:00:00'));
});
test('overnight ranges and future recurring start dates use local calendar days', () => {
  const alert = { ...base, time: '23:30', lengthMode: 'range', endTime: '01:00', repeat: 'daily' };
  const due = dueOccurrence(alert, at('2026-09-24T00:15:00'));
  assert.equal(due.start, at('2026-09-23T23:30:00')); assert.equal(due.end, at('2026-09-24T01:00:00'));
  assert.equal(nextOccurrence({ ...base, repeat: 'weekdays' }, at('2026-09-25T11:00:00')), at('2026-09-28T09:00:00'));
  assert.equal(nextOccurrence({ ...base, date: '2027-01-04', repeat: 'daily' }, at('2026-09-23T11:00:00')), at('2027-01-04T09:00:00'));
});
test('short focus windows retain seconds and DST ranges follow the chosen wall clock', () => {
  const minute = occurrenceOn({ ...base, durationMinutes: 1 }, new Date('2026-09-23T00:00:00'));
  assert.equal(minute.end - minute.start, 60000);
  const previous = process.env.TZ; process.env.TZ = 'Europe/London';
  try {
    const fall = occurrenceOn({ ...base, date: '2026-10-24', time: '23:30', lengthMode: 'range', endTime: '02:30' }, new Date('2026-10-24T00:00:00'));
    assert.equal(fall.end - fall.start, 4 * 3600000);
    const spring = occurrenceOn({ ...base, date: '2026-03-28', time: '23:30', lengthMode: 'range', endTime: '02:30' }, new Date('2026-03-28T00:00:00'));
    assert.equal(spring.end - spring.start, 2 * 3600000);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('alarms-after-quit is opt-in and its wake task survives unusual paths and never expires', () => {
  assert.equal(validatePreferences({}).alertsAfterQuit, false);
  assert.equal(validatePreferences({ alertsAfterQuit: 'yes' }).alertsAfterQuit, false);
  assert.equal(validatePreferences({ alertsAfterQuit: true }).alertsAfterQuit, true);
  const xml = wakeTaskXml(at('2026-09-23T08:59:30'), "C:\\Users\\Zoë O'Neil\\R&D <1>\\Still.exe", '--alarm-wake');
  assert.ok(xml.includes('<StartBoundary>2026-09-23T08:59:30</StartBoundary>'));
  assert.ok(xml.includes('<Command>C:\\Users\\Zoë O&#39;Neil\\R&#38;D &#60;1&#62;\\Still.exe</Command>'));
  for (const setting of ['<StartWhenAvailable>true', '<ExecutionTimeLimit>PT0S', '<DisallowStartIfOnBatteries>false', '<RunLevel>LeastPrivilege', '<Arguments>--alarm-wake<']) assert.ok(xml.includes(setting), setting);
});
