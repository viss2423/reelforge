// Apply the saved theme before first paint so there is no flash or layout shift. A separate
// (blocking, same-origin) file because the server's CSP forbids inline scripts.
try {
  var t = localStorage.getItem('rf.theme')
  if (t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches))
    document.documentElement.dataset.theme = 'light'
} catch {
  // Storage blocked (private mode): keep the default dark theme.
}
