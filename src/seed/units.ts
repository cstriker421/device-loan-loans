import type { NewDevice } from '../domain/device';

/** The device models in the Catalogue Service's seed data. */
export const CATALOGUE_MODEL_IDS = [
  'dm-001', 'dm-002', 'dm-003', 'dm-004', 'dm-005', 'dm-006', 'dm-007', 'dm-008',
] as const;

/** Builds `perModel` physical units for each model. Ids are fixed, so re-seeding is safe. */
export function buildUnits(modelIds: readonly string[], perModel: number): NewDevice[] {
  return modelIds.flatMap((modelId) =>
    Array.from({ length: perModel }, (_, i) => ({
      id: `${modelId}-u${i + 1}`,
      modelId,
      assetTag: `TEES-${modelId.replace('dm-', '')}-${i + 1}`,
    })),
  );
}
