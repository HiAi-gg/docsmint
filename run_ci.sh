cd /mnt/ai_data/projects/hiai-docs
bun -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.workspaces = pkg.workspaces.filter(w => !w.includes('hiai-ui'));
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"
bun -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('frontend/package.json', 'utf8'));
  if (pkg.dependencies && pkg.dependencies['@hiai-gg/hiai-ui']) {
    pkg.dependencies['@hiai-gg/hiai-ui'] = '^0.0.1';
  }
  fs.writeFileSync('frontend/package.json', JSON.stringify(pkg, null, 2));
"
bun install
bun run test
