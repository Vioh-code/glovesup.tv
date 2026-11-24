// Countdown dates (05-screen-inventory): the server writes each date as
// <time datetime="ISO UTC">Nov 25, 22:54 UTC</time>. This rewrites the text in
// the browser's own time zone with its short name, e.g. "Nov 25, 4:54 PM CST",
// and keeps the UTC text as the hover title. Without JavaScript, or if a date
// or Intl fails, the UTC text stays. External file: the CSP blocks inline scripts.
(function () {
  'use strict';
  var fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch (e) {
    return;
  }
  var els = document.querySelectorAll('time[datetime]');
  for (var i = 0; i < els.length; i += 1) {
    var d = new Date(els[i].getAttribute('datetime'));
    if (!isNaN(d.getTime())) {
      els[i].title = els[i].textContent;
      els[i].textContent = fmt.format(d);
    }
  }
}());
