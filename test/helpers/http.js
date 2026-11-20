// Shared test helpers: a tiny cookie-keeping browser for the real app.
// No tests in this file. It never imports the app or opens a DB connection.

// Reads the whole body before returning: express-session saves the session
// after headers are sent, so the body is the signal the save is done.
class Browser {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(path, { method = 'GET', form, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = this.cookieHeader();
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(`${this.base}${path}`, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const html = await res.text();
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, html };
  }

  get(path) { return this.request(path); }

  post(path, form) { return this.request(path, { method: 'POST', form }); }

  // GET a page with a form and return its CSRF token.
  async csrfFrom(path) {
    const { html } = await this.get(path);
    const m = /name="_csrf" value="([^"]*)"/.exec(html);
    return m ? m[1] : '';
  }
}

async function listen(app, host) {
  const server = app.listen(0, host);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://${host}:${server.address().port}` };
}

module.exports = { Browser, listen };
