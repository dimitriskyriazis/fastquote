/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

// Ensure the cached Next-generated type artifacts are removed before running `tsc`.
['.next/types', '.next/dev/types'].forEach((relativeDir) => {
  const absoluteDir = path.resolve(process.cwd(), relativeDir);
  fs.rmSync(absoluteDir, { recursive: true, force: true });
});
