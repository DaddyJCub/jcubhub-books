'use strict';
// Broker access-token validation for native JCubHub Apps clients.
//
// Verifies the HS256 access token minted by the central identity broker
// (issuer "jcubhub-apps-identity"), enforces capability claims (deny-by-default),
// and exposes the caller's identity on req.native. No cookies — Bearer only.
//
// The signing key matches the central broker: IDENTITY_TOKEN_SIGNING_SECRET if
// set, else a key DERIVED from ENCRYPTION_KEY with the same domain-separation
// label the broker uses (see backend/app/integrations/identity/tokens.py).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'jcubhub-apps-identity';
const DERIVE_LABEL = 'jcubhub-apps:identity-access-token-signing:v1';

function resolveSigningKey() {
  const explicit = (process.env.IDENTITY_TOKEN_SIGNING_SECRET || '').trim();
  if (explicit) return explicit;
  const enc = (process.env.ENCRYPTION_KEY || '').trim();
  if (enc) return crypto.createHmac('sha256', enc).update(DERIVE_LABEL).digest('hex');
  return null;
}

function errorBody(code, message) {
  return { error: { code, message } };
}

/** Express middleware: require a valid broker token. Sets req.native = { userId, username, email, caps }. */
function requireBrokerAuth(req, res, next) {
  const key = resolveSigningKey();
  if (!key) {
    return res.status(503).json(errorBody('upstream_unavailable', 'Native auth not configured (no signing key)'));
  }
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json(errorBody('unauthorized', 'Missing Bearer token'));
  }
  let payload;
  try {
    payload = jwt.verify(match[1], key, { algorithms: ['HS256'], issuer: ISSUER });
  } catch (err) {
    return res.status(401).json(errorBody('unauthorized', 'Invalid or expired token'));
  }
  if (!payload.email) {
    return res.status(403).json(errorBody('forbidden', 'Token has no email claim; cannot scope requests'));
  }
  req.native = {
    userId: payload.sub,
    username: payload.username,
    email: payload.email,
    caps: Array.isArray(payload.caps) ? payload.caps : [],
  };
  next();
}

/** Require a specific capability (deny-by-default). */
function requireCapability(cap) {
  return function (req, res, next) {
    if (!req.native || !req.native.caps.includes(cap)) {
      return res.status(403).json(errorBody('forbidden', `Missing capability: ${cap}`));
    }
    next();
  };
}

module.exports = { requireBrokerAuth, requireCapability, resolveSigningKey, ISSUER };
