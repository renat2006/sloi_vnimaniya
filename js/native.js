const cap = typeof window !== 'undefined' ? window.Capacitor : null;
const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
const NOTE_ID = 1001;

const call = (plugin, method, opts) => {
  try {
    return Promise.resolve(cap.nativePromise(plugin, method, opts || {})).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
};

function hapticKind(pattern) {
  if (Array.isArray(pattern)) return 'success';
  if (pattern >= 18) return 'rupture';
  if (pattern >= 14) return 'click';
  if (pattern >= 11) return 'soft';
  return 'tick';
}

function haptic(pattern) {
  if (!isNative) return false;
  call('SloiBridge', 'haptic', { kind: hapticKind(pattern) }).then((r) => {
    if (r !== null) return;
    if (Array.isArray(pattern)) call('Haptics', 'notification', { type: 'WARNING' });
    else call('Haptics', 'impact', { style: pattern <= 10 ? 'LIGHT' : 'MEDIUM' });
  });
  return true;
}

function keepAwake(on) {
  if (!isNative) return false;
  call('SloiBridge', 'keepAwake', { on: !!on });
  return true;
}

async function addTile() {
  if (!isNative) return null;
  return call('SloiBridge', 'addTile');
}

function onBack(cb) {
  if (!isNative) return;
  try {
    cap.addListener('App', 'backButton', () => cb());
  } catch {}
}

function minimize() {
  return call('App', 'minimizeApp');
}

function widget(state) {
  if (!isNative) return;
  call('SloiBridge', 'setState', state);
}

async function enableReminders() {
  if (!isNative) return false;
  let r = await call('LocalNotifications', 'checkPermissions');
  if (!r || r.display !== 'granted') r = await call('LocalNotifications', 'requestPermissions');
  return !!(r && r.display === 'granted');
}

async function pinWidget() {
  if (!isNative) return false;
  const r = await call('SloiBridge', 'pinWidget');
  return !!(r && r.requested);
}

async function scheduleEnd(endAt) {
  if (!isNative || !(endAt > Date.now())) return;
  await call('LocalNotifications', 'createChannel', {
    id: 'session-end',
    name: 'Окончание сеанса',
    description: 'Сигнал, когда время сеанса вышло',
    importance: 4,
    visibility: 1,
    vibration: true
  });
  call('LocalNotifications', 'schedule', {
    notifications: [{
      id: NOTE_ID,
      title: 'Слои внимания',
      body: 'Сеанс завершён — можно извлечь керн',
      channelId: 'session-end',
      smallIcon: 'ic_stat_sloi',
      schedule: { at: new Date(endAt).toISOString(), allowWhileIdle: true },
      extra: { go: 'stage' }
    }]
  });
}

function cancelEnd() {
  if (!isNative) return;
  call('LocalNotifications', 'cancel', { notifications: [{ id: NOTE_ID }] });
}

function onOpen(cb) {
  if (!isNative) return;
  const fromUrl = (url) => {
    try {
      const u = new URL(url);
      if (u.hash.startsWith('#s=')) {
        cb('guest', u.hash.slice(3));
        return;
      }
      const go = u.searchParams.get('go');
      if (go) cb(go, Object.fromEntries(u.searchParams));
    } catch {}
  };
  try {
    cap.addListener('App', 'appUrlOpen', (e) => fromUrl(e && e.url));
    cap.addListener('LocalNotifications', 'localNotificationActionPerformed', () => cb('stage'));
  } catch {}
  call('App', 'getLaunchUrl').then((r) => r && r.url && fromUrl(r.url));
}

export const native = { isNative, haptic, keepAwake, addTile, onBack, minimize, widget, pinWidget, enableReminders, scheduleEnd, cancelEnd, onOpen };
