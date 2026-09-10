const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_RECAPTCHA_SITE_KEY &&
    process.env.GOOGLE_RECAPTCHA_SECRET_KEY
  );
}

async function verifyToken(token, remoteIp) {
  const params = new URLSearchParams({
    secret: process.env.GOOGLE_RECAPTCHA_SECRET_KEY,
    response: token,
  });

  if (remoteIp) {
    params.append('remoteip', remoteIp);
  }

  const response = await fetch(RECAPTCHA_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json();
  return data.success === true;
}

function requireRecaptcha({ view, title }) {
  return async (req, res, next) => {
    if (!isConfigured()) {
      return next();
    }

    const token = req.body['g-recaptcha-response'];
    let verified = false;

    if (token) {
      try {
        verified = await verifyToken(token, req.ip);
      } catch (err) {
        console.error('reCAPTCHA verification error:', err);
      }
    }

    if (!verified) {
      return res.status(400).render(view, {
        title,
        siteKey: process.env.GOOGLE_RECAPTCHA_SITE_KEY,
        error: 'Please complete the reCAPTCHA challenge.',
        formData: req.body,
      });
    }

    next();
  };
}

module.exports = { isConfigured, requireRecaptcha };
