/* global document, location, URL, URLSearchParams */
// Preserve the Papr-assigned app identity when moving between the two console pages.
const assigned = new URLSearchParams(location.search).get('appId') || document.documentElement.dataset.appId;
if (assigned) for (const link of document.querySelectorAll('a[href]')) {
  const target = new URL(link.getAttribute('href'), location.href);
  if (target.origin === location.origin && (target.pathname===location.pathname || /\/(?:index|publishing)\.html$/.test(target.pathname))) {
    target.searchParams.set('appId', assigned); link.href = target.href;
  }
}
