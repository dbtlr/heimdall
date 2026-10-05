import { versionLine } from './version.ts';

const [command] = process.argv.slice(2);

if (command === '--version') {
  console.log(versionLine());
} else {
  console.error('usage: heimdall-hub --version');
  process.exitCode = 2;
}
