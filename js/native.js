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

function haptic(pattern) {
  if (!isNative) return false;
  if (Array.isArray(pattern)) {
    call('Haptics', 'notification', { type: 'WARNING' });
  } else if (pattern <= 10) {
    call('Haptics', 'impact', { style: 'LIGHT' });
  } else if (pattern <= 20) {
    call('Haptics', 'impact', { style: 'MEDIUM' });
  } else {
    call('Haptics', 'vibrate', { duration: pattern });
  }
  return true;
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

function scheduleEnd(endAt) {
  if (!isNative || !(endAt > Date.now())) return;
  call('LocalNotifications', 'schedule', {
    notifications: [{
      id: NOTE_ID,
      title: 'Слои внимания',
      body: 'Сеанс завершён — можно извлечь керн',
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
      const go = new URL(url).searchParams.get('go');
      if (go) cb(go);
    } catch {}
  };
  try {
    cap.addListener('App', 'appUrlOpen', (e) => fromUrl(e && e.url));
    cap.addListener('LocalNotifications', 'localNotificationActionPerformed', () => cb('stage'));
  } catch {}
  call('App', 'getLaunchUrl').then((r) => r && r.url && fromUrl(r.url));
}

if (isNative) call('SystemBars', 'setStyle', { style: 'DARK' });

export const native = { isNative, haptic, widget, pinWidget, enableReminders, scheduleEnd, cancelEnd, onOpen };
