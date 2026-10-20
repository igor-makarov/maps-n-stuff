import { existsSync } from 'node:fs';

if (existsSync(new URL('../DEPLOYMENT_PAUSED', import.meta.url))) {
  console.error('Deployment is paused by the repository owner. Remove DEPLOYMENT_PAUSED only when deployments are authorized to resume.');
  process.exit(1);
}
