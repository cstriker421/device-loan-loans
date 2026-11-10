// Seeds device units through the repository port (safe to run more than once)
import { getDeviceRepo } from '../config/appServices';
import { createDevice } from '../domain/device';
import { buildUnits, CATALOGUE_MODEL_IDS } from './units';

const UNITS_PER_MODEL = 3;

async function main(): Promise<void> {
  if (!process.env.COSMOS_KEY) {
    console.error('COSMOS_KEY is not set in this shell. Export it, then run again.');
    process.exit(1);
  }

  const repo = getDeviceRepo();
  let created = 0;
  let skipped = 0;

  for (const input of buildUnits(CATALOGUE_MODEL_IDS, UNITS_PER_MODEL)) {
    const device = createDevice(input); // validates the seed data too
    if (await repo.get(device.modelId, device.id)) {
      skipped++;
      continue;
    }
    await repo.add(device);
    created++;
  }

  console.log(`Seed complete: ${created} created, ${skipped} already present.`);
}

main().catch((error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
