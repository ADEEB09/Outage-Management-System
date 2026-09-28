// Sets up the running Keycloak so the crew mobile app can sign in.
//
// Idempotent — safe to re-run; it creates what's missing and updates what
// exists. Talks to Keycloak's admin REST API, so it works on an existing
// Keycloak with data already in it (the realm JSON in infra/ is only read on
// a fresh import).
//
// What it does, in realm oms-upcl:
//   1. `oms-mobile` client: public, Authorization Code + PKCE (S256), redirect
//      omscrew://auth (installed app) and exp://* (Expo Go / dev), and a mapper
//      that puts the user's crew_id attribute into the token as `crew_id`.
//   2. `crew_id` user-profile attribute (Keycloak 24 drops attributes that
//      aren't declared in the user profile), admin-editable only.
//   3. `field_crew` realm role.
//   4. Test crew logins crew01..crew06 -> crews C001..C006 (the seeded crews).
//   5. sslRequired = none, so phones can sign in over plain HTTP on the LAN.
//      Keycloak's default ("external") refuses non-localhost HTTP logins.
//      TESTING ONLY — use HTTPS and put this back to "external" for real use.
//
// Usage (from backend/, with Keycloak running):
//   npm run keycloak:mobile
//   CREW_PASSWORD=Secret123 npm run keycloak:mobile
//
// Env:
//   KEYCLOAK_URL             default http://localhost:18080
//   KEYCLOAK_ADMIN           default admin
//   KEYCLOAK_ADMIN_PASSWORD  default admin
//   CREW_PASSWORD            password for all test crew logins (default crew123)

const KC = (process.env.KEYCLOAK_URL || 'http://localhost:18080').replace(/\/$/, '');
const REALM = 'oms-upcl';
const ADMIN_USER = process.env.KEYCLOAK_ADMIN || 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';
const CREW_PASSWORD = process.env.CREW_PASSWORD || 'crew123';
const CLIENT_ID = 'oms-mobile';
const CREW_ROLE = 'field_crew';

// Leads from backend/src/infra/seed.js.
const CREWS = [
  ['crew01', 'C001', 'Rajesh', 'Kumar'],
  ['crew02', 'C002', 'Amit', 'Sharma'],
  ['crew03', 'C003', 'Priya', 'Singh'],
  ['crew04', 'C004', 'Suresh', 'Patel'],
  ['crew05', 'C005', 'Meena', 'Rao'],
  ['crew06', 'C006', 'Vijay', 'Nair'],
];

const CREW_ID_MAPPER = {
  name: 'crew_id',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usermodel-attribute-mapper',
  config: {
    'user.attribute': 'crew_id',
    'claim.name': 'crew_id',
    'jsonType.label': 'String',
    'access.token.claim': 'true',
    'id.token.claim': 'true',
    'userinfo.token.claim': 'true',
  },
};

const MOBILE_CLIENT = {
  clientId: CLIENT_ID,
  name: 'OMS Crew mobile app',
  enabled: true,
  publicClient: true,
  protocol: 'openid-connect',
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  // The app redirects to omscrew://auth (src/lib/auth.js). A bare
  // "omscrew://" is not a valid URI to Keycloak, hence the path.
  redirectUris: ['omscrew://*', 'exp://*'],
  webOrigins: [],
  attributes: {
    'pkce.code.challenge.method': 'S256',
    'post.logout.redirect.uris': 'omscrew://*##exp://*',
  },
};

let token = null;

async function kc(method, path, body) {
  const response = await fetch(`${KC}/admin/realms/${REALM}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function adminLogin() {
  const response = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: ADMIN_USER, password: ADMIN_PASSWORD }),
  }).catch((err) => {
    throw new Error(`Cannot reach Keycloak at ${KC} (${err.cause?.code || err.message}). Is it running? (docker compose up -d keycloak)`);
  });
  if (!response.ok) throw new Error(`Keycloak admin login failed (${response.status}) — check KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD.`);
  token = (await response.json()).access_token;
}

async function ensureRealmSettings() {
  const realm = await kc('GET', '');
  if (!realm) throw new Error(`Realm ${REALM} does not exist in ${KC}. Import infra/keycloak-realm.json first.`);
  if (realm.sslRequired !== 'none') {
    await kc('PUT', '', { realm: REALM, sslRequired: 'none' });
    console.log(`  realm: sslRequired ${realm.sslRequired} -> none (plain-HTTP LAN testing only)`);
  } else console.log('  realm: sslRequired already none');
}

async function ensureCrewIdAttribute() {
  const profile = await kc('GET', '/users/profile');
  if (!profile) return; // pre-24 Keycloak without declarative user profile: attributes just work
  if (profile.attributes.some((a) => a.name === 'crew_id')) return console.log('  user profile: crew_id already declared');
  profile.attributes.push({
    name: 'crew_id',
    displayName: 'Crew ID',
    multivalued: false,
    permissions: { view: ['admin'], edit: ['admin'] },
    validations: { pattern: { pattern: '^[A-Za-z0-9_-]{1,64}$', 'error-message': 'Crew ID: letters, digits, _ or -' } },
  });
  await kc('PUT', '/users/profile', profile);
  console.log('  user profile: declared crew_id (admin-only)');
}

async function ensureRole() {
  let role = await kc('GET', `/roles/${CREW_ROLE}`);
  if (!role) {
    await kc('POST', '/roles', { name: CREW_ROLE, description: 'Field crew member using the OMS Crew mobile app' });
    role = await kc('GET', `/roles/${CREW_ROLE}`);
    console.log(`  role: created ${CREW_ROLE}`);
  } else console.log(`  role: ${CREW_ROLE} exists`);
  return role;
}

async function ensureClient() {
  const [existing] = await kc('GET', `/clients?clientId=${CLIENT_ID}`);
  if (!existing) {
    await kc('POST', '/clients', { ...MOBILE_CLIENT, protocolMappers: [CREW_ID_MAPPER] });
    return console.log(`  client: created ${CLIENT_ID}`);
  }
  await kc('PUT', `/clients/${existing.id}`, { ...existing, ...MOBILE_CLIENT, attributes: { ...existing.attributes, ...MOBILE_CLIENT.attributes } });
  const mappers = await kc('GET', `/clients/${existing.id}/protocol-mappers/models`);
  if (!mappers.some((m) => m.name === CREW_ID_MAPPER.name)) {
    await kc('POST', `/clients/${existing.id}/protocol-mappers/models`, CREW_ID_MAPPER);
  }
  console.log(`  client: updated ${CLIENT_ID}`);
}

async function ensureCrewUser([username, crewId, firstName, lastName], role) {
  const rep = {
    username,
    enabled: true,
    firstName,
    lastName,
    email: `${username}@oms.local`,
    emailVerified: true,
    requiredActions: [],
    attributes: { crew_id: [crewId] },
  };
  let [user] = await kc('GET', `/users?username=${encodeURIComponent(username)}&exact=true`);
  if (!user) {
    await kc('POST', '/users', rep);
    [user] = await kc('GET', `/users?username=${encodeURIComponent(username)}&exact=true`);
  } else {
    await kc('PUT', `/users/${user.id}`, { ...rep, attributes: { ...user.attributes, crew_id: [crewId] } });
  }
  await kc('PUT', `/users/${user.id}/reset-password`, { type: 'password', value: CREW_PASSWORD, temporary: false });
  await kc('POST', `/users/${user.id}/role-mappings/realm`, [role]);
  // Read back: Keycloak silently drops undeclared attributes, so confirm.
  const saved = await kc('GET', `/users/${user.id}`);
  if (saved.attributes?.crew_id?.[0] !== crewId) throw new Error(`crew_id was not saved on ${username} — check the realm's user profile.`);
  console.log(`  user: ${username} -> ${crewId}`);
}

async function main() {
  console.log(`Configuring ${KC}/realms/${REALM} for the crew mobile app`);
  await adminLogin();
  await ensureRealmSettings();
  await ensureCrewIdAttribute();
  const role = await ensureRole();
  await ensureClient();
  for (const crew of CREWS) await ensureCrewUser(crew, role);
  console.log(`\nDone. Crew logins: ${CREWS.map((c) => c[0]).join(', ')} / password: ${CREW_PASSWORD}`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
