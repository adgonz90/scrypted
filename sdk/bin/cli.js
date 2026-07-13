#!/usr/bin/env node
const path = require('path');
// On Windows, npm's generated .cmd/.ps1 shims always invoke this file
// directly, so argv[1] is this script's own path rather than the bin name.
// Fall back to npm_lifecycle_script, which npm sets to the invoked command
// (e.g. "scrypted-webpack") when run via `npm run <script>`.
const command = path.basename(process.argv[1]) === path.basename(__filename)
    ? (process.env.npm_lifecycle_script || path.basename(process.argv[1]))
    : path.basename(process.argv[1]);

switch (command) {
    case 'scrypted-webpack':
        require('../dist/src/bin/scrypted-webpack.js');
        break;
    case 'scrypted-deploy':
        require('../dist/src/bin/scrypted-deploy.js');
        break;
    case 'scrypted-deploy-debug':
        require('../dist/src/bin/scrypted-deploy-debug.js');
        break;
    case 'scrypted-debug':
        require('../dist/src/bin/scrypted-debug.js');
        break;
    case 'scrypted-package-json':
        require('../dist/src/bin/scrypted-package-json.js');
        break;
    case 'scrypted-changelog':
        require('../dist/src/bin/scrypted-changelog.js');
        break;
    case 'scrypted-setup-project':
        require('../dist/src/bin/scrypted-setup-project.js');
        break;
    default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
}
