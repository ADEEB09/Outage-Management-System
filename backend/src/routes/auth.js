import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Configurable, same pattern as DATABASE_URL/REDIS_URL/KAFKA_BROKERS â€” the
// right value depends on where this runs:
//   - Laptop dev (Keycloak via docker-compose, no other containers): http://localhost:8080/...
//   - Inside Docker (backend + keycloak both containers, same compose network):
//     http://keycloak:8081/... â€” "keycloak" is the container's service name,
//     not localhost, because localhost inside a container means the
//     container itself, not its neighbors. Same lesson as the earlier
//     Postgres/Redis/Kafka container-networking fixes.
const KEYCLOAK_JWKS_URI = process.env.KEYCLOAK_JWKS_URI
  || 'http://localhost:8080/realms/oms-upcl/protocol/openid-connect/certs';

const client = jwksClient({ jwksUri: KEYCLOAK_JWKS_URI });

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// Verifies the Bearer token on every request and attaches the decoded
// roles to req.user. Rejects with 401 if missing/invalid.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = {
      username: decoded.preferred_username,
      roles: (decoded.realm_access && decoded.realm_access.roles) || [],
    };
    next();
  });
}

// Use after requireAuth on routes that need a specific role.
export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.some((r) => req.user.roles.includes(r))) {
      return res.status(403).json({ error: 'Insufficient role' });
    }
    next();
  };
}