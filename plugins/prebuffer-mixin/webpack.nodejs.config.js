const path = require('path');
const defaultConfig = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);

// @scrypted/common/src/deferred.ts and promise-utils.ts are symlinks nested inside the
// node_modules/@scrypted/common file: dependency symlink (a "double hop"): resolving
// '@scrypted/common/src/deferred' has to follow node_modules/@scrypted/common -> common/, and then
// common/src/deferred.ts -> server/src/deferred.ts. webpack's enhanced-resolve can't follow that
// second hop on this Windows setup and fails with TS2307, so alias these two directly to their real
// files to bypass symlink resolution entirely.
//
// Same fix as plugins/homekit/webpack.nodejs.config.js - see that file for the original write-up.
defaultConfig.resolve.alias['@scrypted/common/src/deferred'] = path.resolve(__dirname, '../../server/src/deferred.ts');
defaultConfig.resolve.alias['@scrypted/common/src/promise-utils'] = path.resolve(__dirname, '../../server/src/promise-utils.ts');

module.exports = defaultConfig;
