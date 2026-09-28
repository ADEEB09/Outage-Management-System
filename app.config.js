// Extends app.json. Only the EAS "test" profile sets OMS_ALLOW_CLEARTEXT=1,
// letting that APK reach the plain-HTTP map test server on the LAN.
// preview/production builds never allow cleartext traffic.
export default ({ config }) => {
  if (process.env.OMS_ALLOW_CLEARTEXT !== '1') return config;
  return {
    ...config,
    plugins: [...config.plugins, ['expo-build-properties', { android: { usesCleartextTraffic: true } }]],
  };
};
