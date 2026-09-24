module.exports = {
  appId: 'site.renat.sloi',
  appName: 'Слои внимания',
  webDir: 'www',
  backgroundColor: '#08090B',
  server: {
    url: process.env.SLOI_URL || 'https://sloi.renat.site',
    cleartext: !!process.env.SLOI_URL && process.env.SLOI_URL.startsWith('http://'),
    errorPath: 'index.html'
  },
  plugins: {
    LocalNotifications: { smallIcon: 'ic_stat_sloi', iconColor: '#D8CBB0' },
    SystemBars: { style: 'DARK' }
  },
  android: { allowMixedContent: false }
};
