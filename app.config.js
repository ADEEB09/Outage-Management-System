// Extends app.json. Only the EAS "test" profile sets OMS_ALLOW_CLEARTEXT=1,
// letting that APK reach the OMS backend and Keycloak over plain HTTP on the
// LAN (see docs/MOBILE_TESTING.md). preview/production builds never allow
// cleartext traffic.
export default ({ config }) => {
  if (process.env.OMS_ALLOW_CLEARTEXT !== '1') return config;
  return {
    ...config,
    plugins: [...config.plugins, ['expo-build-properties', { android: { usesCleartextTraffic: true } }]],
  };
};
