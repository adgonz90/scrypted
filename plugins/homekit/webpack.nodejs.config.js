const path = require('path');
const defaultConfig = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);

// @homebridge/hap-nodejs uses readFileSync(require.resolve('package.json'))
// transform it to a plain require() which webpack handles correctly.
// [\\/] instead of a literal / - webpack's resource path uses backslashes on Windows, so a
// forward-slash-only regex here never matches and this loader silently never ran.
defaultConfig.module.rules.push({
    test: /node_modules[\\/]@homebridge[\\/]hap-nodejs[\\/]dist[\\/]lib[\\/]model[\\/]AccessoryInfo\.js$/,
    loader: path.resolve(__dirname, 'webpack-accessory-info-loader.js'),
    enforce: 'pre',
});

// @scrypted/common/src/deferred.ts and promise-utils.ts are symlinks nested inside the
// node_modules/@scrypted/common file: dependency symlink (a "double hop"), pointing into
// @scrypted/server. webpack's enhanced-resolve can't follow that second hop on this Windows
// setup, so alias these two directly to their real files to bypass symlink resolution entirely.
defaultConfig.resolve.alias['@scrypted/common/src/deferred'] = path.resolve(__dirname, '../../server/src/deferred.ts');
defaultConfig.resolve.alias['@scrypted/common/src/promise-utils'] = path.resolve(__dirname, '../../server/src/promise-utils.ts');

module.exports = defaultConfig;
