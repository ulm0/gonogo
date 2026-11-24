// throwaway file for testing auto-review; closed unmerged
const { execSync } = require('node:child_process');
function run(userInput) {
  return execSync('ls ' + userInput).toString();
}
module.exports = { run };
