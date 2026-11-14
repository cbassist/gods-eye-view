const clip = (value, max) => {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function properties(record, snapshot) {
  const statusLabel =
    record.status === 'active'
      ? 'Active (Caltrans status)'
      : 'Planned (not confirmed active)';
  const closureDetails = clip(
    [
      record.typeOfClosure,
      record.typeOfWork,
      record.lanesClosed && `Lanes: ${record.lanesClosed}`,
    ]
      .filter(Boolean)
      .join(' · '),
    80,
  );
  const geometryDetails =
    'Begin point only; not road-following or proof of full road closure.';
  return {
    ...record,
    name: clip(
      `${statusLabel} · ${record.begin.route || 'Caltrans closure'}`,
      120,
    ),
    closureDetails: closureDetails || statusLabel,
    geometryDetails,
    __gevDetails: [closureDetails || statusLabel, geometryDetails],
    sourceUrl: snapshot.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    attribution: 'California Department of Transportation (Caltrans)',
  };
}

/**
 * Convert a normalized source snapshot to bounded begin-point GeoJSON, no I/O.
 * Status is the normalizer's official-code status, never a schedule inference.
 * recordAt is the source observation; fetchedAt is retrieval, not freshness.
 * For library re-presentation use label: 'name' and fields:
 * ['closureDetails', 'geometryDetails'] (the library rebuilds __gevDetails).
 * All original normalized properties remain read-only by convention.
 * @param {{ records: object[], sourceUrl: string, fetchedAt: number }} snapshot
 * @param {{ includePlanned?: boolean, maxFeatures?: number }} options
 * @returns {object} FeatureCollection with filteredCount, invalidGeometryCount,
 * eligibleCount, truncatedCount and truncated. Cap defaults/hard-limits to 1000;
 * zero is permitted. Counts refer to normalized records, not raw upstream rows.
 */
export function caltransLaneClosuresToGeojson(
  snapshot,
  { includePlanned = false, maxFeatures = 1000 } = {},
) {
  if (!Array.isArray(snapshot?.records))
    throw new TypeError('invalid_caltrans_snapshot');
  if (!Number.isSafeInteger(maxFeatures) || maxFeatures < 0)
    throw new RangeError('invalid_maxFeatures');
  const cap = Math.min(maxFeatures, 1000);
  const features = [];
  let filteredCount = 0;
  let invalidGeometryCount = 0;
  let eligibleCount = 0;
  for (const record of snapshot.records) {
    if (
      record?.status !== 'active' &&
      !(includePlanned === true && record?.status === 'planned')
    ) {
      filteredCount++;
      continue;
    }
    const point = record.begin?.coordinates;
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) > 90 ||
      (point[0] === 0 && point[1] === 0)
    ) {
      invalidGeometryCount++;
      continue;
    }
    eligibleCount++;
    if (features.length >= cap) continue;
    features.push({
      type: 'Feature',
      id: record.id,
      geometry: { type: 'Point', coordinates: [...point] },
      properties: properties(record, snapshot),
    });
  }
  const truncatedCount = eligibleCount - features.length;
  return {
    type: 'FeatureCollection',
    features,
    filteredCount,
    invalidGeometryCount,
    eligibleCount,
    truncatedCount,
    truncated: truncatedCount > 0,
  };
}
