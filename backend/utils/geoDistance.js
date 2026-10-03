/**
 * Great-circle distance between two GPS points, using the Haversine formula, with no dependencies.
 *
 * Why Haversine
 * -------------
 * A GPS fix is a point on the Earth's surface given as latitude φ and longitude λ in degrees. The
 * shortest surface path between two points is an arc of a great circle; its length is the central
 * angle between them (in radians) multiplied by the Earth's radius. Haversine computes that angle in
 * a form that stays numerically accurate for the very small separations a geofence deals with (a
 * few metres to a few kilometres). The textbook spherical law of cosines, acos(...), loses most of
 * its precision there, because cos of a tiny angle is indistinguishable from 1 in floating point.
 *
 * The formula
 * -----------
 *   φ1, φ2  latitudes in radians          Δφ = φ2 − φ1
 *   λ1, λ2  longitudes in radians         Δλ = λ2 − λ1
 *
 *   a = sin²(Δφ / 2) + cos φ1 · cos φ2 · sin²(Δλ / 2)     the "haversine" of the central angle,
 *                                                         0 for the same point, 1 for antipodes
 *   c = 2 · atan2(√a, √(1 − a))                           the central angle θ in radians
 *   d = R · c                                             arc length in metres
 *
 *   - cos φ1 · cos φ2 shrinks the east-west term toward the poles, where meridians converge.
 *   - atan2(√a, √(1−a)) equals asin(√a) but stays well-conditioned for every a in [0, 1].
 *   - `a` is clamped to [0, 1]: floating-point rounding can push it a hair outside that range for
 *     identical or antipodal points, and √ of a negative number would produce NaN.
 *   - Crossing the antimeridian (λ jumping from +179.9° to −179.9°) needs no special case:
 *     sin²(Δλ/2) has a period of 360°, so a Δλ of 359.8° gives the same result as −0.2°.
 *
 * Accuracy
 * --------
 * R is the IUGG mean Earth radius, 6,371,008.8 m. Modelling the Earth as a sphere instead of the
 * WGS-84 ellipsoid gives at most about 0.3 % error, which is 0.6 m on a 200 m geofence. That is far
 * below the 5–20 m error of a phone's GPS fix, so the sphere is not the limiting factor.
 */

/** IUGG mean radius of the Earth, in metres. */
export const EARTH_MEAN_RADIUS_METRES = 6_371_008.8;

const RADIANS_PER_DEGREE = Math.PI / 180;

/** A latitude: a finite JSON number from −90 to 90 inclusive. */
export function isValidLatitude(candidateLatitude) {
  return typeof candidateLatitude === 'number' && Number.isFinite(candidateLatitude) && candidateLatitude >= -90 && candidateLatitude <= 90;
}

/** A longitude: a finite JSON number from −180 to 180 inclusive. */
export function isValidLongitude(candidateLongitude) {
  return typeof candidateLongitude === 'number' && Number.isFinite(candidateLongitude) && candidateLongitude >= -180 && candidateLongitude <= 180;
}

/**
 * True for (0, 0), "Null Island" in the Gulf of Guinea. Devices and SDKs report it when they have
 * no fix but fill in a default, so it is treated as missing data rather than a real location.
 */
export function isNullIsland({ lat, lng }) {
  return lat === 0 && lng === 0;
}

/**
 * Distance in metres between two points along the Earth's surface.
 * @param {{ lat: number, lng: number }} fromPoint  degrees
 * @param {{ lat: number, lng: number }} toPoint    degrees
 * @returns {number} metres, >= 0
 */
export function haversineDistanceMetres(fromPoint, toPoint) {
  const fromLatitudeRadians = fromPoint.lat * RADIANS_PER_DEGREE;
  const toLatitudeRadians = toPoint.lat * RADIANS_PER_DEGREE;
  const latitudeDeltaRadians = (toPoint.lat - fromPoint.lat) * RADIANS_PER_DEGREE;
  const longitudeDeltaRadians = (toPoint.lng - fromPoint.lng) * RADIANS_PER_DEGREE;

  const sinHalfLatitudeDelta = Math.sin(latitudeDeltaRadians / 2);
  const sinHalfLongitudeDelta = Math.sin(longitudeDeltaRadians / 2);
  const haversineOfCentralAngle =
    sinHalfLatitudeDelta * sinHalfLatitudeDelta + Math.cos(fromLatitudeRadians) * Math.cos(toLatitudeRadians) * sinHalfLongitudeDelta * sinHalfLongitudeDelta;

  const clampedHaversine = Math.min(1, Math.max(0, haversineOfCentralAngle));
  const centralAngleRadians = 2 * Math.atan2(Math.sqrt(clampedHaversine), Math.sqrt(1 - clampedHaversine));
  return EARTH_MEAN_RADIUS_METRES * centralAngleRadians;
}
