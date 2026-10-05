// Copy the web app into dist/ for the desktop build, bundling KaTeX and
// highlight.js (when installed via npm) so the app works offline.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const item of ['index.html', 'css', 'js', 'icon.svg', 'manifest.webmanifest']) {
  fs.cpSync(path.join(root, item), path.join(dist, item), { recursive: true });
}

const vendor = [
  ['node_modules/katex/dist/katex.min.js', 'vendor/katex/katex.min.js'],
  ['node_modules/katex/dist/katex.min.css', 'vendor/katex/katex.min.css'],
  ['node_modules/katex/dist/fonts', 'vendor/katex/fonts'],
  ['node_modules/@highlightjs/cdn-assets/highlight.min.js', 'vendor/highlight.min.js'],
];
for (const [from, to] of vendor) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) {
    console.warn('build-web: missing ' + from + ' (run npm install); the app will fall back to the CDN');
    continue;
  }
  fs.mkdirSync(path.dirname(path.join(dist, to)), { recursive: true });
  fs.cpSync(src, path.join(dist, to), { recursive: true });
}
console.log('build-web: wrote ' + path.relative(root, dist));
