// Contact-space effects shared by image, SVG/GIF textures, and external video.
struct Contact {
  rect: vec4f, // Other card center and half size in world coordinates.
  pose: vec4f, // cos, sin, participant key, role (+lifted / -cover / 0 motion).
  metric: vec4f, // Crossing: pixel scale/depth/partner/span. Motion: pixel scale/RGB energy/wake energy/phase.
  axis: vec4f, // Separation direction away from other card; shared contact center.
}
struct Contacts {
  header: vec4f, // count, RGB strength, RGB decay progress, wake strength
  timeline: vec4f, // continuous lift depth, direction, event progress, wake decay progress
  tuning: vec4f, // RGB split in CSS pixels, wake width in CSS pixels, reserved
  items: array<Contact>,
}
@group(1) @binding(0) var<storage, read> contacts: Contacts;
@group(1) @binding(1) var<storage, read> contactIndex: array<u32>;

// Resolve membership once per vertex, not once per covered pixel. Newly admitted
// composition keys have no range until the next upload and must not read stale data.
fn crossingRange(key: u32) -> vec2u {
  if (contacts.header.x == 0.0 || key >= contactIndex[10]) { return vec2u(0u); }
  let offset = contactIndex[11] + key * 2u;
  return vec2u(contactIndex[offset], contactIndex[offset + 1u]);
}

// Lifted material bypasses occlusion. Non-lifted cards keep resting scene order.
fn crossingDepth(key: u32, range: vec2u, selected: bool) -> f32 {
  if (contacts.header.x == 0.0 || key >= contactIndex[10] || selected) { return 0.0; }
  for (var entry = 0u; entry < range.y; entry++) {
    if (contacts.items[contactIndex[range.x + entry]].pose.w > 0.0) { return 0.0; }
  }
  let base = contactIndex[11] + contactIndex[10] * 2u + u32(contacts.header.x);
  let metadata = contactIndex[base + key];
  if ((metadata & 0x80000000u) != 0u) { return 0.0; }
  let rank = metadata & 0x7fffffffu;
  if (rank == 0u) { return 0.0; }
  return 1.0 - f32(rank) / f32(contactIndex[10] + 1u);
}

fn crossingIsActive(key: u32) -> u32 {
  if (contacts.header.x == 0.0 || key >= contactIndex[10]) { return 0u; }
  let base = contactIndex[11] + contactIndex[10] * 2u + u32(contacts.header.x);
  return (contactIndex[base + key] >> 31u);
}

// Bound the base-alpha sample's displacement. RGB red/blue offsets do not
// affect output alpha. Retain extra pixels at the edge; never assume opacity.
fn crossingOcclusionMargin(range: vec2u, size: vec2f) -> vec2f {
  var margin = 0.0;
  let lift = contacts.timeline.x;
  let pressure = 4.0 * lift * (1.0 - lift);
  let echo = smoothstep(0.2, 0.75, contacts.timeline.z) * pow(1.0 - contacts.header.z, 2.0);
  let wake = smoothstep(0.0, 0.2, contacts.timeline.z) * pow(1.0 - contacts.timeline.w, 2.0);
  for (var entry = 0u; entry < range.y; entry++) {
    let contact = contacts.items[contactIndex[range.x + entry]];
    let motion = contact.pose.w == 0.0;
    let passing = pressure * max(1.0 - smoothstep(0.02, 0.38, abs(lift - contact.metric.y)), 0.4);
    let rgbPulse = select(passing + 0.22 * echo, contact.metric.y, motion);
    let wakePulse = select(wake, contact.metric.z, motion);
    let flow = select(1.0, max(1.0, length(contact.axis.xy)), motion);
    margin = max(margin, contact.metric.x * (5.0 * abs(contacts.header.y * rgbPulse) + 9.0 * abs(contacts.header.w * wakePulse) * flow));
  }
  return vec2f(margin) / max(size, vec2f(1.0)) + vec2f(0.00001);
}

fn crossingGrid(index: u32) -> vec2f {
  let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(1,0), vec2f(1,1), vec2f(0,1));
  return corners[index % 6u];
}
fn contactDistance(local: vec2f, halfSize: vec2f) -> f32 {
  let q = abs(local) - halfSize;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}
fn contactNormal(local: vec2f, halfSize: vec2f) -> vec2f {
  let q = abs(local) - halfSize;
  let signXY = select(vec2f(-1.0), vec2f(1.0), local >= vec2f(0.0));
  if (q.x > 0.0 && q.y > 0.0) { return normalize(q) * signXY; }
  return select(vec2f(0.0, signXY.y), vec2f(signXY.x, 0.0), q.x > q.y);
}
fn contactRotate(v: vec2f, pose: vec2f) -> vec2f {
  return vec2f(v.x * pose.x - v.y * pose.y, v.x * pose.y + v.y * pose.x);
}
fn contactLocal(v: vec2f, pose: vec2f) -> vec2f {
  return vec2f(dot(v, pose), dot(v, vec2f(-pose.y, pose.x)));
}

struct ContactField {
  coverage: f32,
  passing: f32,
  role: f32,
  pixel: f32,
  distance: f32,
  normal: vec2f,
  rgbPulse: f32,
  wakePulse: f32,
  radius: f32,
  phase: f32,
  flow: vec2f,
  rgbFlow: vec2f,
  rgbRadius: f32,
  rgbWidth: f32,
}
// Select the strongest nearby contact. Deep stacks cannot amplify without bound.
fn crossingField(world: vec2f, range: vec2u) -> ContactField {
  var result: ContactField;
  var best = -1.0;
  var winner = 0u;
  var winnerLocal = vec2f(0.0);
  var winnerDistance = 0.0;
  var winnerPulses = vec3f(0.0);
  let lift = contacts.timeline.x;
  let pressure = 4.0 * lift * (1.0 - lift);
  let rgbEcho = smoothstep(0.2, 0.75, contacts.timeline.z) * pow(1.0 - contacts.header.z, 2.0);
  let crossingWake = smoothstep(0.0, 0.2, contacts.timeline.z) * pow(1.0 - contacts.timeline.w, 2.0);
  for (var entry = 0u; entry < range.y; entry++) {
    let contact = contacts.items[contactIndex[range.x + entry]];
    let local = contactLocal(world - contact.rect.xy, contact.pose.xy);
    let sd = contactDistance(local, contact.rect.zw);
    let pixel = contact.metric.x;
    let zWindow = 1.0 - smoothstep(0.02, 0.38, abs(lift - contact.metric.y));
    let passing = pressure * max(zWindow, 0.4);
    let motion = contact.pose.w == 0.0;
    let rgbPulse = select(passing + 0.22 * rgbEcho, contact.metric.y, motion);
    let wakePulse = select(crossingWake, contact.metric.z, motion);
    let score = exp(-max(sd, 0.0) / max(120.0 * pixel, 1.0)) * max(rgbPulse, wakePulse);
    if (score <= 0.00001) { continue; }
    if (score <= best) { continue; }
    best = score;
    winner = contactIndex[range.x + entry];
    winnerLocal = local;
    winnerDistance = sd;
    winnerPulses = vec3f(passing, rgbPulse, wakePulse);
  }
  if (best < 0.0) { return result; }
  // Selection needs only distance and pulse strength. Evaluate flow, normals,
  // and the traveling front once, after the winning contact is known.
  let contact = contacts.items[winner];
  let local = winnerLocal;
  let sd = winnerDistance;
  let passing = winnerPulses.x;
  let rgbPulse = winnerPulses.y;
  let wakePulse = winnerPulses.z;
  let pixel = contact.metric.x;
  let motion = contact.pose.w == 0.0;
  result.coverage = 1.0 - smoothstep(-24.0 * pixel, 24.0 * pixel, sd);
  result.passing = passing;
  result.role = select(contact.pose.w, -1.0, motion);
  result.pixel = pixel;
  result.distance = sd;
  result.normal = contactRotate(contactNormal(local, contact.rect.zw), contact.pose.xy);
  result.wakePulse = wakePulse;
  result.radius = select(6.0 + (contacts.timeline.z * 0.25 + contacts.timeline.w) * 96.0, 6.0 + contact.axis.z, motion);
  result.phase = select(0.0, contact.metric.w, motion);
  result.flow = select(result.normal * contacts.timeline.y, contact.axis.xy, motion);
  if (rgbPulse == 0.0) { return result; }
  // Drag refraction comes from the advancing edge, in the direction of travel.
  // During a depth crossing both participants share one entry-to-exit direction.
  let rgbFlow = select(-contact.axis.xy * contact.pose.w * contacts.timeline.y, contact.axis.xy, motion);
  let coherence = min(length(rgbFlow), 1.0);
  let direction = rgbFlow / max(length(rgbFlow), 0.0001);
  let localDirection = contactLocal(direction, contact.pose.xy);
  let extent = dot(abs(localDirection), contact.rect.zw);
  // Bias the whole overlap toward its advancing side, without reducing the
  // effect to the mover's perimeter or introducing a seam at its center.
  let along = dot(world - contact.rect.xy, direction) / max(extent, pixel);
  let leading = mix(0.45, 1.0, smoothstep(-1.0, 1.0, along));
  let front = mix(-extent, extent, contacts.timeline.z);
  let frontWidth = max(24.0 * pixel, extent * 0.45);
  let frontDistance = dot(world - contact.rect.xy, direction) - front;
  let crossingWave = 0.25 + 0.75 * exp(-frontDistance * frontDistance / (2.0 * frontWidth * frontWidth));
  result.rgbPulse = rgbPulse * coherence * select(crossingWave, leading, motion);
  result.rgbFlow = direction;
  result.rgbRadius = select(0.0, contact.axis.z * (0.5 + contact.metric.y), motion);
  result.rgbWidth = select(18.0, 14.0 + 12.0 * contact.metric.y, motion);
  return result;
}
struct CrossingPaint {
  slice: u32,
  selected: u32,
  debug: u32,
  border: vec2f,
}
fn sampleCrossingTexture(uv: vec2f) -> vec4f {
  // Composition owns preview LOD and these textures have exactly one mip level.
  // Explicit level sampling remains defined after per-pixel slice rejection.
  return textureSampleLevel(entityTexture, entitySampler, uv, 0.0);
}
fn crossingSample(uv: vec2f, paint: CrossingPaint) -> vec4f {
  let outside = any(uv < vec2f(0.0)) || any(uv > vec2f(1.0));
  if (paint.selected == 1u && outside && all(uv >= -paint.border) && all(uv <= vec2f(1.0) + paint.border)) {
    let blue = vec3f(59.0 / 255.0, 130.0 / 255.0, 246.0 / 255.0);
    return vec4f(select(blue, vec3f(1.0, 0.0, 0.0), paint.debug == 1u), 1.0);
  }
  let color = sampleCrossingTexture(clamp(uv, vec2f(0.0), vec2f(1.0)));
  return color * select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)));
}
fn crossingMaterial(uv: vec2f, world: vec2f, range: vec2u, size: vec2f, pose: vec2f, paint: CrossingPaint, alphaOnly: bool) -> vec4f {
  if (range.y == 0u) { return crossingSample(uv, paint); }
  let field = crossingField(world, range);
  if (field.pixel == 0.0) { return crossingSample(uv, paint); }
  let pixel = vec2f(field.pixel) / max(size, vec2f(1.0));
  let local = (uv - 0.5) * size;
  let ownDistance = contactDistance(local, size * 0.5);
  let seamDistance = max(ownDistance, field.distance);
  // A rectangle's nearest-edge normal jumps along its corner bisectors.
  // Use the continuous travel direction for both bend and dispersion instead.
  let direction = contactLocal(field.rgbFlow, pose);
  // A subtle displacement is shared by all three color samples. RGB refraction
  // stays coherent with the moving wake rather than compositing a second image.
  let waveDistance = abs(field.distance / field.pixel) - field.radius;
  let width = contacts.tuning.y;
  let packet = exp(-waveDistance * waveDistance / (2.0 * width * width)) * sin((waveDistance - field.phase) / (width * 0.643));
  let wakeAmplitude = field.wakePulse * contacts.header.w;
  let warp = contactLocal(field.flow, pose) * pixel * packet * wakeAmplitude * 9.0;

  if (field.rgbPulse == 0.0 || contacts.header.y == 0.0) {
    let base = crossingSample(uv + warp, paint);
    // Preserve the original premultiplied reconstruction even at tiny alpha.
    return vec4f(base.rgb * base.a / max(base.a, 0.001), base.a);
  }

  let d = seamDistance / field.pixel - field.rgbRadius;
  let band = exp(-d * d / (2.0 * field.rgbWidth * field.rgbWidth));
  // Carry color through the overlap interior as well as its contact rim.
  let influence = max(band, 0.65 * field.coverage);
  let energy = field.rgbPulse * influence * contacts.header.y;
  let bend = direction * pixel * energy * 5.0 * field.role;
  let split = direction * pixel * energy * contacts.tuning.x;
  let base = crossingSample(uv + warp + bend, paint);
  if (alphaOnly || all(split == vec2f(0.0))) {
    return vec4f(base.rgb * base.a / max(base.a, 0.001), base.a);
  }
  let red = crossingSample(uv + warp + bend + split, paint);
  let blue = crossingSample(uv + warp + bend - split, paint);
  let rgb = vec3f(red.r * red.a, base.g * base.a, blue.b * blue.a) / max(base.a, 0.001);
  return vec4f(rgb, base.a);
}

// Partition the lifted material between draws below/above each covering card.
// For alpha a, a lower slice with weight w and remaining weight r above it uses
// a*w/(1-a*r). Source-over then preserves the original alpha exactly, including
// transparent partners and feathered edges. Covering cards keep their own alpha.
fn crossingPartition(world: vec2f, range: vec2u, slice: u32) -> vec2f {
  if (slice == 0u) { return vec2f(1.0, 0.0); }
  var previous = 1.0;
  var below = 1.0;
  var above = 0.0;
  var found = slice == 1u;
  for (var entry = 0u; entry < range.y; entry++) {
    let i = contactIndex[range.x + entry];
    let contact = contacts.items[i];
    if (contact.pose.w <= 0.0) { continue; }
    let lift = contacts.timeline.x;
    let depth = lift - contact.metric.y;
    let activity = 4.0 * lift * (1.0 - lift);
    let along = dot(world - contact.axis.zw, contact.axis.xy) / contact.metric.w;
    let across = dot(world - contact.axis.zw, vec2f(-contact.axis.y, contact.axis.x)) / contact.metric.w;
    let ripple = 0.12 * sin(across * 8.0 - lift * 6.0) * min(contacts.header.w, 1.0);
    let travel = depth + (along + ripple) * activity * 0.28;
    let width = min(0.14, min(contact.metric.y, 1.0 - contact.metric.y) * 0.8);
    // A pixel cannot pass a higher layer before it passes the lower layers.
    let passage = min(previous, smoothstep(-width, width, travel));
    if (found) { above = passage; break; }
    if (slice == i + 2u) { below = passage; found = true; }
    previous = passage;
  }
  return vec2f(max(below - above, 0.0), above);
}
fn crossingColor(uv: vec2f, world: vec2f, range: vec2u, size: vec2f, pose: vec2f, paint: CrossingPaint) -> vec4f {
  // Zero partition weight is independent of source alpha. Avoid contact-field
  // evaluation and all three material samples on pixels assigned to another slice.
  let weights = crossingPartition(world, range, paint.slice);
  if (weights.x == 0.0) {
    return vec4f(0.0);
  }
  let color = crossingMaterial(uv, world, range, size, pose, paint, false);
  let alpha = color.a * weights.x / max(1.0 - color.a * weights.y, 0.000001);
  return vec4f(color.rgb, alpha);
}
