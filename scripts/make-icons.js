'use strict';
// Renders build/icon.svg into the PNG sizes the app and installer need.
const sharp = require('sharp');
const path = require('path');

const svg = path.join(__dirname, '..', 'build', 'icon.svg');
(async () => {
  await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(path.join(__dirname, '..', 'build', 'icon.png'));
  await sharp(svg, { density: 96 }).resize(256, 256).png().toFile(path.join(__dirname, '..', 'build', 'icon-256.png'));
  await sharp(svg, { density: 96 }).resize(64, 64).png().toFile(path.join(__dirname, '..', 'src', 'renderer', 'favicon.png'));
  console.log('icons written');
})();
