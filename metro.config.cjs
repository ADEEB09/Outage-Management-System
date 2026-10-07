// Metro config for the crew app (native + web).
// expo-sqlite (the offline location queue) loads a .wasm file on web, which
// Metro must treat as an asset for the web build to bundle.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("wasm");

module.exports = config;
