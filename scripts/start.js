'use strict';
// Launches the app with a clean environment. Terminals hosted inside Electron apps
// (e.g. VS Code) export ELECTRON_RUN_AS_NODE, which would make Electron act as plain Node.
const { spawn } = require('child_process');
const electron = require('electron');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('close', (code) => process.exit(code ?? 0));
